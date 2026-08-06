from typing import Callable, List, Optional

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from models import UserData
from user_auth.routes import check_user, get_db


async def get_user_optional(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Optional[UserData]:
    """
    Returns the current user if authenticated; otherwise None.
    Raises for non-auth related errors to avoid hiding real failures.
    """
    try:
        return await check_user(request, db)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            return None
        raise


def require_roles(allowed_roles: List[str]) -> Callable:
    """
    Dependency factory enforcing role-based access.
    - If '*' is in allowed_roles, authentication is optional (returns user or None).
    - Otherwise, the user must be authenticated and have one of the allowed roles.
    """
    allow_anonymous = "*" in allowed_roles

    async def dependency(
        user: Optional[UserData] = Depends(
            get_user_optional if allow_anonymous else check_user
        ),
    ) -> Optional[UserData]:
        if allow_anonymous:
            return user

        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
            )

        if not any(role in allowed_roles for role in user.roles):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
            )
        return user

    return dependency
