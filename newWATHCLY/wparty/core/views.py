from django.shortcuts import render


def landing_view(request):
    active_session = None
    if request.user.is_authenticated:
        from rooms.models import RoomParticipant
        participant = (
            RoomParticipant.objects
            .filter(user=request.user, room__is_active=True)
            .select_related('room')
            .order_by('-joined_at')
            .first()
        )
        if participant:
            active_session = participant.room
    return render(request, 'core/landing.html', {'active_session': active_session})
