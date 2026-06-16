from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.conf import settings
from .models import Room, RoomParticipant, ChatMessage, RoomSession
from .forms import CreateRoomForm, JoinRoomForm
from .utils import parse_video_url
import os


@login_required
def create_room_view(request):
    if request.method == 'POST':
        form = CreateRoomForm(request.POST)
        if form.is_valid():
            room = form.save(commit=False)
            room.host = request.user
            if not room.is_private:
                room.password = ''
            if room.max_participants not in (3, 6, 8, 12):
                room.max_participants = 8
            room.save()
            request.session[f'room_access_{room.code}'] = True
            # Флаг для TV-анимации — одноразовый, только для хоста-создателя
            request.session['room_intro_code'] = room.code
            return redirect('rooms:detail', code=room.code)
    else:
        form = CreateRoomForm()
    return render(request, 'rooms/create.html', {'form': form})


@login_required
def room_detail_view(request, code):
    room = get_object_or_404(Room, code=code)

    if room.is_private:
        allowed = request.session.get(f'room_access_{code}', False)
        if not allowed and room.host != request.user:
            return redirect('rooms:join', code=code)

    MAX_PARTICIPANTS = room.max_participants
    current_count = RoomParticipant.objects.filter(room=room).count()
    already_in = RoomParticipant.objects.filter(room=room, user=request.user).exists()
    if not already_in and current_count >= MAX_PARTICIPANTS:
        messages.error(request, f'Комната заполнена (максимум {MAX_PARTICIPANTS} участников).')
        return redirect('/')

    RoomParticipant.objects.get_or_create(room=room, user=request.user)

    # Проверяем первый ли это визит ДО update_or_create
    is_first_visit = not RoomSession.objects.filter(
        user=request.user, room_code=room.code
    ).exists()

    # Сохраняем/обновляем снапшот посещения (сохраняется даже после удаления комнаты)
    RoomSession.objects.update_or_create(
        user=request.user,
        room_code=room.code,
        defaults={
            'room': room,
            'room_name': room.name,
            'is_private': room.is_private,
            'video_platform': room.video_platform or '',
        }
    )

    # Анимация при первом входе (хост при создании + новые участники)
    # Если вход через пароль с анимацией замка — пропускаем интро
    skip_intro = request.session.pop(f'room_skip_intro_{code}', False)
    request.session.pop(f'room_beam_{code}', None)
    request.session.pop('room_intro_code', None)
    show_intro = is_first_visit and not skip_intro

    messages_qs = ChatMessage.objects.filter(room=room).select_related('user__profile').order_by('created_at')[:100]

    return render(request, 'rooms/detail.html', {
        'room': room,
        'chat_messages': messages_qs,
        'show_intro': show_intro,
    })


@login_required
def join_room_view(request, code):
    room = get_object_or_404(Room, code=code, is_private=True)

    if room.host == request.user:
        request.session[f'room_access_{code}'] = True
        return redirect('rooms:detail', code=code)

    if request.method == 'POST':
        form = JoinRoomForm(request.POST)
        if form.is_valid():
            pwd = form.cleaned_data['password']
            if pwd == room.password:
                request.session[f'room_access_{code}'] = True
                return redirect('rooms:detail', code=code)
            else:
                messages.error(request, 'Неверный пароль.')
    else:
        form = JoinRoomForm()

    return render(request, 'rooms/join.html', {'form': form, 'room': room})


@login_required
@require_POST
def check_password_view(request, code):
    """AJAX: проверяет пароль приватной комнаты, ставит session flag."""
    room = get_object_or_404(Room, code=code, is_private=True)
    import json
    try:
        body = json.loads(request.body)
        pwd = body.get('password', '')
    except Exception:
        pwd = request.POST.get('password', '')
    if pwd == room.password:
        request.session[f'room_access_{code}'] = True
        request.session[f'room_skip_intro_{code}'] = True
        return JsonResponse({'ok': True})
    return JsonResponse({'ok': False}, status=403)


def set_video_url_view(request, code):
    """API endpoint to set video URL for a room (via AJAX)."""
    room = get_object_or_404(Room, code=code)
    # Проверяем host_only_video
    if room.host_only_video and room.host != request.user:
        return JsonResponse({'status': 'error', 'message': 'Только хост может менять видео.'}, status=403)
    url = request.POST.get('url', '').strip()
    result = parse_video_url(url)
    if result:
        room.current_video_url = url
        room.current_embed_url = result['embed_url']
        room.video_platform = result['platform']
        room.current_time = 0
        room.is_playing = False
        room.save(update_fields=['current_video_url', 'current_embed_url', 'video_platform', 'current_time', 'is_playing'])
        return JsonResponse({'status': 'ok', 'embed_url': result['embed_url'], 'platform': result['platform']})
    return JsonResponse({'status': 'error', 'message': 'Неверный URL. Поддерживаются только VK Видео и RuTube.'}, status=400)


@login_required
@require_POST
def upload_video_view(request, code):
    """Загрузка видео-файла для комнаты."""
    room = get_object_or_404(Room, code=code)
    if room.host_only_video and room.host != request.user:
        return JsonResponse({'status': 'error', 'message': 'Только хост может загружать видео.'}, status=403)

    video_file = request.FILES.get('video')
    if not video_file:
        return JsonResponse({'status': 'error', 'message': 'Файл не выбран.'}, status=400)

    # Проверяем тип файла
    allowed_types = ['video/mp4', 'video/webm', 'video/ogg', 'video/avi',
                     'video/mov', 'video/mkv', 'video/x-matroska',
                     'video/quicktime', 'video/x-msvideo']
    content_type = video_file.content_type or ''
    ext = os.path.splitext(video_file.name)[1].lower()
    allowed_exts = {'.mp4', '.webm', '.ogg', '.avi', '.mov', '.mkv'}
    if ext not in allowed_exts:
        return JsonResponse({'status': 'error', 'message': f'Формат {ext} не поддерживается. Используйте: mp4, webm, mkv, avi, mov.'}, status=400)

    # Ограничение размера — 2 GB
    max_size = 2 * 1024 * 1024 * 1024
    if video_file.size > max_size:
        return JsonResponse({'status': 'error', 'message': 'Файл слишком большой (максимум 2 ГБ).'}, status=400)

    # Сохраняем в media/videos/<room_code>/
    import uuid
    save_dir = os.path.join(settings.MEDIA_ROOT, 'videos', code)
    os.makedirs(save_dir, exist_ok=True)
    filename = f'{uuid.uuid4().hex}{ext}'
    filepath = os.path.join(save_dir, filename)

    with open(filepath, 'wb+') as dest:
        for chunk in video_file.chunks():
            dest.write(chunk)

    video_url = f'{settings.MEDIA_URL}videos/{code}/{filename}'

    room.current_video_url = video_url
    room.current_embed_url = video_url
    room.video_platform = 'local'
    room.current_time = 0
    room.is_playing = False
    room.save(update_fields=['current_video_url', 'current_embed_url', 'video_platform', 'current_time', 'is_playing'])

    return JsonResponse({'status': 'ok', 'embed_url': video_url, 'platform': 'local', 'filename': video_file.name})


@login_required
@require_POST
def delete_room_view(request, code):
    """Завершение/удаление комнаты хостом."""
    room = get_object_or_404(Room, code=code)
    if room.host != request.user:
        return JsonResponse({'status': 'error', 'message': 'Только хост может завершить сессию.'}, status=403)
    room.is_active = False
    room.save(update_fields=['is_active'])
    return JsonResponse({'status': 'ok'})
