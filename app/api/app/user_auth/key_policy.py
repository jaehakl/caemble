"""Account eligibility shared by access token issuance and authentication."""

from sqlalchemy import select

from user_auth.db import Role, User, UserRole


def active_access_key_users(user_id: str | None = None):
    query = select(User.id).join(UserRole, UserRole.user_id == User.id).join(
        Role, Role.id == UserRole.role_id
    ).where(User.is_active.is_(True), Role.name.in_(("admin", "user")))
    if user_id is not None:
        query = query.where(User.id == user_id)
    return query
