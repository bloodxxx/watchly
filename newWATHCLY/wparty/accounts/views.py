from django.shortcuts import render, redirect
from django.contrib.auth import login, logout, update_session_auth_hash
from django.contrib.auth.forms import AuthenticationForm, PasswordChangeForm
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from .forms import RegisterForm, ProfileForm, AvatarForm
from rooms.models import Room, RoomSession


def register_view(request):
    if request.user.is_authenticated:
        return redirect('core:landing')
    if request.method == 'POST':
        form = RegisterForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            messages.success(request, 'Добро пожаловать в CineSync!')
            return redirect('core:landing')
    else:
        form = RegisterForm()
    return render(request, 'accounts/register.html', {'form': form})


def login_view(request):
    if request.user.is_authenticated:
        return redirect('core:landing')
    if request.method == 'POST':
        form = AuthenticationForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            next_url = request.GET.get('next', '/')
            return redirect(next_url)
        else:
            messages.error(request, 'Неверный логин или пароль.')
    else:
        form = AuthenticationForm()
    # Add css class to form fields
    for field in form.fields.values():
        field.widget.attrs['class'] = 'form-input'
    return render(request, 'accounts/login.html', {'form': form})


def logout_view(request):
    logout(request)
    return redirect('core:landing')


@login_required
def profile_view(request):
    profile = request.user.profile
    sessions = RoomSession.objects.filter(
        user=request.user
    ).order_by('-last_seen')[:20]

    if request.method == 'POST':
        form = ProfileForm(request.POST, instance=profile, user=request.user)
        if form.is_valid():
            profile = form.save()
            user = request.user
            user.first_name = form.cleaned_data['first_name']
            user.last_name = form.cleaned_data['last_name']
            user.email = form.cleaned_data['email']
            user.save()
            messages.success(request, 'Профиль обновлён.')
            return redirect('accounts:profile')
    else:
        form = ProfileForm(instance=profile, user=request.user)

    avatar_form = AvatarForm(instance=profile)

    sessions_count = RoomSession.objects.filter(user=request.user).count()
    hosted_count   = Room.objects.filter(host=request.user).count()

    return render(request, 'accounts/profile.html', {
        'form': form,
        'avatar_form': avatar_form,
        'sessions': sessions,
        'sessions_count': sessions_count,
        'hosted_count': hosted_count,
    })


@login_required
def avatar_upload_view(request):
    if request.method == 'POST':
        form = AvatarForm(request.POST, request.FILES, instance=request.user.profile)
        if form.is_valid():
            form.save()
            messages.success(request, 'Аватар обновлён.')
    return redirect('accounts:profile')


@login_required
def change_password_view(request):
    if request.method == 'POST':
        form = PasswordChangeForm(request.user, request.POST)
        if form.is_valid():
            user = form.save()
            update_session_auth_hash(request, user)
            messages.success(request, 'Пароль успешно изменён.')
            return redirect('accounts:profile')
        else:
            messages.error(request, 'Ошибка при смене пароля.')
    return redirect('accounts:profile')
