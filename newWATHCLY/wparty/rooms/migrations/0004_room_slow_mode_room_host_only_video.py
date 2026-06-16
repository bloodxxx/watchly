from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('rooms', '0003_room_auto_delete_room_chat_enabled_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='slow_mode',
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name='room',
            name='host_only_video',
            field=models.BooleanField(default=False),
        ),
    ]
