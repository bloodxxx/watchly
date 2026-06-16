from django.urls import path
from . import views

app_name = 'rooms'

urlpatterns = [
    path('create/', views.create_room_view, name='create'),
    path('<str:code>/', views.room_detail_view, name='detail'),
    path('<str:code>/join/', views.join_room_view, name='join'),
    path('<str:code>/check-password/', views.check_password_view, name='check_password'),
    path('<str:code>/set-video/', views.set_video_url_view, name='set_video'),
    path('<str:code>/upload-video/', views.upload_video_view, name='upload_video'),
    path('<str:code>/delete/', views.delete_room_view, name='delete_room'),
]
