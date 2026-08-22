class CatalogError(RuntimeError):
    """Base error raised by the catalog package."""


class CatalogNotFoundError(CatalogError):
    """The requested catalog row does not exist."""


class CatalogAmbiguousError(CatalogError):
    """A compatibility lookup matched more than one catalog identity."""


class CatalogIntegrityError(CatalogError):
    """The SQLite file is corrupt or incompatible with this package."""
