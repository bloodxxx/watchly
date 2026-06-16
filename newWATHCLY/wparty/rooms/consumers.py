import json
import time
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async

# Храним актуальное состояние хоста в памяти (обновляется из heartbeat)
_host_state: dict = {}
# Slow mode: last_message_time[room_code][username] = timestamp
_last_message: dict = {}


class RoomConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        self.room_code = self.scope['url_route']['kwargs']['code']
        self.group_name = f'room_{self.room_code}'
        self.user = self.scope['user']

        if not self.user.is_authenticated:
            await self.close()
            return

        # Проверяем лимит участников из настроек комнаты
        count = await self.get_participant_count()
        max_p = await self.get_max_participants()
        if count >= max_p:
            await self.accept()
            await self.send(text_data=json.dumps({
                'type': 'room_full',
                'message': f'Комната заполнена (максимум {max_p} участников)',
            }))
            await self.close()
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.add_participant()

        await self.channel_layer.group_send(self.group_name, {
            'type': 'user_joined',
            'username': self.user.username,
        })

        state = await self.get_room_state()
        if state:
            # Если есть более свежее состояние хоста в памяти — используем его
            mem = _host_state.get(self.room_code)
            if mem:
                elapsed = time.time() - mem['updated_at']
                current_time = mem['time']
                if mem['playing']:
                    current_time += elapsed  # учитываем дрейф пока хост играл
                state['current_time'] = current_time
                state['is_playing']   = mem['playing']

            await self.send(text_data=json.dumps({
                'type': 'sync_state',
                **state,
            }))

        await self.broadcast_participants()

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.remove_participant()
            await self.channel_layer.group_send(self.group_name, {
                'type': 'user_left',
                'username': self.user.username,
            })
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
            await self.broadcast_participants()

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        event_type = data.get('type')

        if event_type == 'chat_message':
            text = data.get('text', '').strip()
            if not text:
                return
            # Проверяем что чат включён
            chat_ok = await self.get_chat_enabled()
            if not chat_ok:
                return
            # Проверяем slow mode (хост не ограничен)
            is_host = await self.is_host()
            if not is_host:
                slow = await self.get_slow_mode()
                if slow > 0:
                    room_msgs = _last_message.setdefault(self.room_code, {})
                    last = room_msgs.get(self.user.username, 0)
                    if time.time() - last < slow:
                        return   # слишком рано — молча игнорируем
                    room_msgs[self.user.username] = time.time()
            await self.save_message(text)
            await self.channel_layer.group_send(self.group_name, {
                'type': 'chat_message',
                'username': self.user.username,
                'text': text,
                'avatar': await self.get_avatar_url(),
            })

        elif event_type == 'video_url_change':
            url = data.get('url', '').strip()
            # Проверяем host_only_video
            host_only = await self.get_host_only_video()
            if host_only and not await self.is_host():
                return
            result = await self.set_video_url(url)
            if result:
                _host_state.pop(self.room_code, None)
                await self.channel_layer.group_send(self.group_name, {
                    'type': 'video_url_change',
                    'embed_url': result['embed_url'],
                    'platform': result['platform'],
                    'original_url': url,
                    'username': self.user.username,
                })

        elif event_type == 'host_play':
            current_time = data.get('current_time', 0)
            play_at = data.get('play_at', 0)
            await self.update_playback(True, current_time)
            # Обновляем in-memory состояние хоста
            _host_state[self.room_code] = {
                'time': current_time,
                'playing': True,
                'updated_at': time.time(),
            }
            await self.channel_layer.group_send(self.group_name, {
                'type': 'host_play',
                'current_time': current_time,
                'play_at': play_at,
                'username': self.user.username,
            })

        elif event_type == 'host_pause':
            current_time = data.get('current_time', 0)
            await self.update_playback(False, current_time)
            _host_state[self.room_code] = {
                'time': current_time,
                'playing': False,
                'updated_at': time.time(),
            }
            await self.channel_layer.group_send(self.group_name, {
                'type': 'host_pause',
                'current_time': current_time,
                'username': self.user.username,
            })

        elif event_type == 'seek':
            current_time = data.get('current_time', 0)
            is_playing = data.get('is_playing', False)
            await self.update_playback(is_playing, current_time)
            _host_state[self.room_code] = {
                'time': current_time,
                'playing': is_playing,
                'updated_at': time.time(),
            }
            await self.channel_layer.group_send(self.group_name, {
                'type': 'seek',
                'current_time': current_time,
                'is_playing': is_playing,
                'username': self.user.username,
            })

        elif event_type == 'room_close':
            if await self.is_host():
                await self.mark_room_inactive()
                _host_state.pop(self.room_code, None)
                await self.channel_layer.group_send(self.group_name, {
                    'type': 'room_closed',
                    'username': self.user.username,
                })

        elif event_type == 'player_ready':
            await self.channel_layer.group_send(self.group_name, {
                'type': 'player_ready',
                'username': self.user.username,
            })

        elif event_type == 'heartbeat':
            current_time = data.get('current_time', 0)
            playing = data.get('playing', False)
            # Хост шлёт heartbeat — обновляем in-memory состояние (самый актуальный источник)
            if await self.is_host():
                _host_state[self.room_code] = {
                    'time': current_time,
                    'playing': playing,
                    'updated_at': time.time(),
                }
            await self.channel_layer.group_send(self.group_name, {
                'type': 'heartbeat',
                'username': self.user.username,
                'current_time': current_time,
                'playing': playing,
            })

        elif event_type == 'sync_request':
            state = await self.get_room_state()
            if state:
                mem = _host_state.get(self.room_code)
                if mem:
                    elapsed = time.time() - mem['updated_at']
                    current_time = mem['time']
                    if mem['playing']:
                        current_time += elapsed
                    state['current_time'] = current_time
                    state['is_playing']   = mem['playing']
                await self.send(text_data=json.dumps({
                    'type': 'sync_state',
                    **state,
                }))

    # ── Group message handlers ──

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'chat_message',
            'username': event['username'],
            'text': event['text'],
            'avatar': event.get('avatar'),
        }))

    async def video_url_change(self, event):
        await self.send(text_data=json.dumps({
            'type': 'video_url_change',
            'embed_url': event['embed_url'],
            'platform': event['platform'],
            'original_url': event['original_url'],
            'username': event['username'],
        }))

    async def host_play(self, event):
        await self.send(text_data=json.dumps({
            'type': 'host_play',
            'current_time': event['current_time'],
            'play_at': event['play_at'],
            'username': event['username'],
        }))

    async def host_pause(self, event):
        await self.send(text_data=json.dumps({
            'type': 'host_pause',
            'current_time': event['current_time'],
            'username': event['username'],
        }))

    async def heartbeat(self, event):
        await self.send(text_data=json.dumps({
            'type': 'heartbeat',
            'username': event['username'],
            'current_time': event['current_time'],
            'playing': event['playing'],
        }))

    async def user_joined(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_joined',
            'username': event['username'],
        }))

    async def user_left(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_left',
            'username': event['username'],
        }))

    async def participants_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'participants_update',
            'participants': event['participants'],
        }))

    async def room_full(self, event):
        await self.send(text_data=json.dumps({
            'type': 'room_full',
            'message': event['message'],
        }))

    async def room_closed(self, event):
        await self.send(text_data=json.dumps({
            'type': 'room_closed',
            'username': event['username'],
        }))

    async def player_ready(self, event):
        await self.send(text_data=json.dumps({
            'type': 'player_ready',
            'username': event['username'],
        }))

    async def seek(self, event):
        await self.send(text_data=json.dumps({
            'type': 'seek',
            'current_time': event['current_time'],
            'is_playing': event['is_playing'],
            'username': event['username'],
        }))

    # ── DB helpers ──

    @database_sync_to_async
    def get_room_state(self):
        from .models import Room
        try:
            room = Room.objects.get(code=self.room_code)
            if not room.current_embed_url:
                return None
            return {
                'embed_url': room.current_embed_url,
                'platform': room.video_platform,
                'original_url': room.current_video_url,
                'current_time': float(room.current_time or 0),
                'is_playing': bool(room.is_playing),
                'is_anonymous': bool(room.is_anonymous),
            }
        except Room.DoesNotExist:
            return None

    @database_sync_to_async
    def is_host(self):
        from .models import Room
        try:
            room = Room.objects.get(code=self.room_code)
            return room.host == self.user
        except Room.DoesNotExist:
            return False

    @database_sync_to_async
    def save_message(self, text):
        from .models import Room, ChatMessage
        room = Room.objects.get(code=self.room_code)
        ChatMessage.objects.create(room=room, user=self.user, text=text)

    @database_sync_to_async
    def set_video_url(self, url):
        from .models import Room
        from .utils import parse_video_url
        result = parse_video_url(url)
        if result:
            Room.objects.filter(code=self.room_code).update(
                current_video_url=url,
                current_embed_url=result['embed_url'],
                video_platform=result['platform'],
                current_time=0,
                is_playing=False,
            )
            return result
        return None

    @database_sync_to_async
    def update_playback(self, is_playing, current_time):
        from .models import Room
        Room.objects.filter(code=self.room_code).update(
            is_playing=is_playing, current_time=current_time
        )

    @database_sync_to_async
    def get_participant_count(self):
        from .models import RoomParticipant
        return RoomParticipant.objects.filter(room__code=self.room_code).count()

    @database_sync_to_async
    def get_max_participants(self):
        from .models import Room
        try:
            return Room.objects.values_list('max_participants', flat=True).get(code=self.room_code)
        except Room.DoesNotExist:
            return 8

    @database_sync_to_async
    def get_participants(self):
        from .models import RoomParticipant
        return list(
            RoomParticipant.objects.filter(room__code=self.room_code)
            .values_list('user__username', flat=True)
        )

    @database_sync_to_async
    def add_participant(self):
        from .models import Room, RoomParticipant
        try:
            room = Room.objects.get(code=self.room_code)
            RoomParticipant.objects.get_or_create(room=room, user=self.user)
        except Room.DoesNotExist:
            pass

    @database_sync_to_async
    def remove_participant(self):
        from .models import RoomParticipant
        RoomParticipant.objects.filter(
            room__code=self.room_code, user=self.user
        ).delete()

    @database_sync_to_async
    def get_avatar_url(self):
        try:
            avatar = self.user.profile.avatar
            if avatar:
                return avatar.url
        except Exception:
            pass
        return None

    @database_sync_to_async
    def get_chat_enabled(self):
        from .models import Room
        try:
            return Room.objects.values_list('chat_enabled', flat=True).get(code=self.room_code)
        except Room.DoesNotExist:
            return True

    @database_sync_to_async
    def get_slow_mode(self):
        from .models import Room
        try:
            return Room.objects.values_list('slow_mode', flat=True).get(code=self.room_code)
        except Room.DoesNotExist:
            return 0

    @database_sync_to_async
    def get_host_only_video(self):
        from .models import Room
        try:
            return Room.objects.values_list('host_only_video', flat=True).get(code=self.room_code)
        except Room.DoesNotExist:
            return False

    @database_sync_to_async
    def mark_room_inactive(self):
        from .models import Room
        Room.objects.filter(code=self.room_code).update(is_active=False)

    async def broadcast_participants(self):
        participants = await self.get_participants()
        await self.channel_layer.group_send(self.group_name, {
            'type': 'participants_update',
            'participants': participants,
        })
