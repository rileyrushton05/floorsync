import asyncio
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.database.session import session_scope
from floorsync_common.users import UserService

NAME = 'Ada Manager'
USERNAME = 'manager'
PASSWORD = 'floorsync-dev'

async def main():
    async with session_scope() as session:
        user = User(name=NAME, role='manager')
        session.add(user)
        await session.flush()
        session.add(
            UserCredential(
                user_id=user.id,
                username=USERNAME,
                password_hash=UserService.hash_password(PASSWORD),
            )
        )
        print('created', USERNAME, user.id)

asyncio.run(main())