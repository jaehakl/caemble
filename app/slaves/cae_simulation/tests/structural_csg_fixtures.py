"""Small numerical fixtures shared by function and entry checks."""


class UnexpectedGeometry:
    async def volume_mesh(self, *_args, **_kwargs):
        raise AssertionError("configuration guard must run before meshing")
