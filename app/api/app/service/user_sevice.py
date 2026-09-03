from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models import UserData
from user_auth.db import User, UserRole


def _to_user_data(user: User) -> UserData:
    return UserData(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        picture_url=user.picture_url,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
        experiment_namespaces=sorted(item.namespace for item in user.experiment_namespaces),
        roles=[user_role.role.name for user_role in user.user_roles],
    )

class UserService:
    """사용자와 연관된 모든 데이터를 가져오는 서비스"""
    
    @staticmethod
    async def get_users(
        limit: int | None,
        offset: int | None,
        db: AsyncSession,
        user_id: str,
    ) -> list[UserData]:
        """
        사용자 목록을 가져옵니다.
        """
        stmt = select(User).options(
            selectinload(User.user_roles).selectinload(UserRole.role)
        ).order_by(User.created_at.desc(), User.id)
        if offset is not None:
            stmt = stmt.offset(offset)
        if limit is not None:
            stmt = stmt.limit(limit)

        users = (await db.execute(stmt)).scalars().all()
        return [_to_user_data(user) for user in users]
    
    @staticmethod
    async def delete_user(id: str, db: AsyncSession, user_id: str) -> bool:
        if id == user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Administrators cannot delete their own account.",
            )
        try:
            user = (await db.execute(
                select(User).where(User.id == id)
            )).scalars().first()
            if not user:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

            await db.delete(user)
            await db.commit()
            return True
        except HTTPException:
            raise
        except Exception:
            await db.rollback()
            raise

    async def get_user_summary(
        who: str,
        db: AsyncSession,
        user_id: str,
    ) -> Optional[UserData]:
        id_to_get = user_id if who == "me" else who

        stmt = (
            select(User)
            .options(selectinload(User.user_roles).selectinload(UserRole.role))
            .where(User.id == id_to_get)
        )

        user = (await db.execute(stmt)).scalar_one_or_none()
        if not user:
            return None

        return _to_user_data(user)

