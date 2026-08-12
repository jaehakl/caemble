import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from user_auth.db import Role, User, UserRole
from user_auth.utils.jwt import make_access


async def create_user(db: AsyncSession, role_name: str = "user") -> User:
    role = await db.scalar(select(Role).where(Role.name == role_name))
    assert role is not None
    user = User(email=f"{uuid.uuid4()}@example.com", display_name="테스트 사용자", is_active=True)
    db.add(user)
    await db.flush()
    db.add(UserRole(user_id=user.id, role_id=role.id))
    await db.commit()
    loaded = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
    ).where(User.id == user.id))
    assert loaded is not None
    return loaded


def auth_headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_access(user)}"}


def experiment_source_bundle(label: str = "experiment") -> dict:
    return {
        "formatVersion": 2,
        "files": {
            "experiment.tsx": label,
            "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return None\n",
            "tasks/main.tsx": "task",
        },
    }
