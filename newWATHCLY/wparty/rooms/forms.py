from django import forms
from .models import Room


class CreateRoomForm(forms.ModelForm):
    password_confirm = forms.CharField(
        max_length=100, required=False, label='Подтвердите пароль',
        widget=forms.PasswordInput(attrs={'class': 'form-input', 'placeholder': 'Повторите пароль'})
    )

    class Meta:
        model = Room
        fields = ('name', 'is_private', 'password', 'max_participants',
                  'is_anonymous', 'chat_enabled', 'slow_mode', 'host_only_video')
        labels = {
            'name': 'Название комнаты',
            'is_private': 'Приватная комната',
            'password': 'Пароль (для приватной)',
            'max_participants': 'Размер комнаты',
            'is_anonymous': 'Анонимный режим',
            'chat_enabled': 'Чат',
            'slow_mode': 'Медленный режим',
            'host_only_video': 'Только хост управляет видео',
        }
        widgets = {
            'name':             forms.TextInput(attrs={'class': 'form-input', 'placeholder': 'Например: Вечер с друзьями'}),
            'is_private':       forms.HiddenInput(),
            'password':         forms.PasswordInput(attrs={'class': 'form-input', 'placeholder': 'Пароль'}),
            'max_participants': forms.HiddenInput(),
            'is_anonymous':     forms.HiddenInput(),
            'chat_enabled':     forms.HiddenInput(),
            'slow_mode':        forms.HiddenInput(),
            'host_only_video':  forms.HiddenInput(),
        }

    def clean(self):
        cleaned = super().clean()
        is_private = cleaned.get('is_private')
        password = cleaned.get('password')
        confirm = cleaned.get('password_confirm')
        if is_private and not password:
            raise forms.ValidationError('Для приватной комнаты укажите пароль.')
        if password and password != confirm:
            raise forms.ValidationError('Пароли не совпадают.')
        return cleaned


class JoinRoomForm(forms.Form):
    password = forms.CharField(
        max_length=100, label='Пароль',
        widget=forms.PasswordInput(attrs={'class': 'form-input', 'placeholder': 'Введите пароль комнаты'})
    )
