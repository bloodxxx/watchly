import random
import string
from django.db import models
from django.contrib.auth.models import User


def generate_room_code():
    chars = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(chars, k=8))
        if not Room.objects.filter(code=code).exists():
            return code


class Room(models.Model):
    code = models.CharField(max_length=8, unique=True, default=generate_room_code)
    name = models.CharField(max_length=100)
    host = models.ForeignKey(User, on_delete=models.CASCADE, related_name='hosted_rooms')
    is_private = models.BooleanField(default=False)
    password = models.CharField(max_length=100, blank=True)
    current_video_url = models.URLField(blank=True, max_length=500)
    current_embed_url = models.URLField(blank=True, max_length=500)
    video_platform = models.CharField(max_length=20, blank=True)  # 'vk' or 'rutube'
    current_time = models.FloatField(default=0)
    is_playing = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)
    max_participants = models.IntegerField(default=8)
    is_anonymous = models.BooleanField(default=False)
    chat_enabled = models.BooleanField(default=True)
    reactions_enabled = models.BooleanField(default=True)
    auto_delete = models.BooleanField(default=False)
    slow_mode = models.IntegerField(default=0)       # секунды между сообщениями: 0/5/10/15
    host_only_video = models.BooleanField(default=False)  # только хост управляет видео

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.name} ({self.code})'

    def get_participant_count(self):
        return self.participants.count()


class RoomParticipant(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='participants')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='room_participations')
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('room', 'user')

    def __str__(self):
        return f'{self.user.username} в {self.room.name}'


class ChatMessage(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='messages')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='chat_messages')
    text = models.TextField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f'{self.user.username}: {self.text[:50]}'


class RoomSession(models.Model):
    """Снапшот посещения комнаты — хранится даже после удаления комнаты."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='room_sessions')
    room = models.ForeignKey(Room, on_delete=models.SET_NULL, null=True, blank=True, related_name='sessions')
    room_code     = models.CharField(max_length=8, db_index=True)
    room_name     = models.CharField(max_length=100)
    is_private    = models.BooleanField(default=False)
    video_platform = models.CharField(max_length=20, blank=True)
    joined_at     = models.DateTimeField(auto_now_add=True)
    last_seen     = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-last_seen']
        unique_together = ('user', 'room_code')

    def __str__(self):
        return f'{self.user.username} → {self.room_name} ({self.room_code})'
