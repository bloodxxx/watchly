from django.contrib import admin
from .models import Room, RoomParticipant, ChatMessage


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ('name', 'code', 'host', 'is_private', 'is_active', 'created_at', 'get_participant_count')
    list_filter = ('is_private', 'is_active', 'video_platform')
    search_fields = ('name', 'code', 'host__username')
    readonly_fields = ('code', 'created_at')


@admin.register(RoomParticipant)
class RoomParticipantAdmin(admin.ModelAdmin):
    list_display = ('user', 'room', 'joined_at')
    list_filter = ('room',)


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    list_display = ('user', 'room', 'text', 'created_at')
    list_filter = ('room',)
    search_fields = ('user__username', 'text')
