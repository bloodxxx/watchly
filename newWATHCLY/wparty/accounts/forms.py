from django import forms
from django.contrib.auth.models import User
from django.contrib.auth.forms import UserCreationForm, PasswordChangeForm
from .models import UserProfile


class RegisterForm(UserCreationForm):
    email = forms.EmailField(required=True, label='Email')

    class Meta:
        model = User
        fields = ('username', 'email', 'password1', 'password2')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.widget.attrs['class'] = 'form-input'
        self.fields['username'].label = 'Имя пользователя'
        self.fields['password1'].label = 'Пароль'
        self.fields['password2'].label = 'Подтвердите пароль'


class ProfileForm(forms.ModelForm):
    first_name = forms.CharField(max_length=50, required=False, label='Имя')
    last_name = forms.CharField(max_length=50, required=False, label='Фамилия')
    email = forms.EmailField(required=False, label='Email')

    class Meta:
        model = UserProfile
        fields = ('bio',)
        labels = {'bio': 'О себе'}

    def __init__(self, *args, **kwargs):
        user = kwargs.pop('user', None)
        super().__init__(*args, **kwargs)
        if user:
            self.fields['first_name'].initial = user.first_name
            self.fields['last_name'].initial = user.last_name
            self.fields['email'].initial = user.email
        for field in self.fields.values():
            field.widget.attrs['class'] = 'form-input'


class AvatarForm(forms.ModelForm):
    class Meta:
        model = UserProfile
        fields = ('avatar',)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['avatar'].widget.attrs['class'] = 'file-input'
        self.fields['avatar'].label = 'Аватар'
