"""Closed-surface integrals and connected material components of canonical solids."""

from collections.abc import Sequence

import numpy as np

from app.kernel.api import ContentKey
from app.methods.geometry.models import MassProperties, SolidComponent, TriangularMesh


def _closed_triangles(mesh: TriangularMesh) -> np.ndarray:
    vertices, faces = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
    if (vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
            or not np.all(np.isfinite(vertices))):
        raise ValueError("solid mesh requires nonempty finite vertices with shape (N, 3)")
    if (faces.ndim != 2 or faces.shape[1] != 3 or not len(faces)
            or faces.dtype.kind not in "iu"):
        raise ValueError("solid mesh requires nonempty integer triangles with shape (M, 3)")
    if np.any(faces < 0) or np.any(faces >= len(vertices)):
        raise ValueError("solid mesh triangle references a vertex outside its mesh")
    if len(mesh.triangle_provenance) != len(faces):
        raise ValueError("solid mesh requires provenance for every triangle")

    # Rendering seams may duplicate a vertex. Exact coordinate welding does not
    # close a physical gap or change the represented surface.
    _, indices = np.unique(vertices, axis=0, return_inverse=True)
    connected = indices[faces]
    triangles = np.asarray(vertices[faces], dtype=np.float64)
    area_vectors = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    if np.any(np.linalg.norm(area_vectors, axis=1) == 0):
        raise ValueError("solid mesh contains a degenerate triangle")
    edges = np.concatenate((connected[:, [0, 1]], connected[:, [1, 2]], connected[:, [2, 0]]))
    _, inverse, counts = np.unique(np.sort(edges, axis=1), axis=0, return_inverse=True, return_counts=True)
    directions = np.bincount(inverse, weights=np.where(edges[:, 0] < edges[:, 1], 1, -1))
    if np.any(counts != 2) or np.any(directions != 0):
        raise ValueError("solid mesh must be a closed consistently oriented manifold surface")
    return triangles


def _surface_moments(mesh: TriangularMesh) -> tuple[float, np.ndarray, np.ndarray]:
    triangles = _closed_triangles(mesh)
    minimum, maximum = triangles.min(axis=(0, 1)), triangles.max(axis=(0, 1))
    origin = minimum + (maximum - minimum) / 2
    local = triangles - origin
    signed = np.einsum("ni,ni->n", local[:, 0], np.cross(local[:, 1], local[:, 2])) / 6
    volume = float(np.sum(signed))
    if not np.isfinite(volume) or abs(volume) <= np.finfo(float).eps * np.sum(np.abs(signed)) * 64:
        raise ValueError("solid mesh must enclose a finite nonzero volume")
    sums = local.sum(axis=1)
    center = np.einsum("n,ni->i", signed, sums) / (4 * volume)
    second = np.einsum(
        "n,nij->ij", signed,
        np.einsum("nki,nkj->nij", local, local) + np.einsum("ni,nj->nij", sums, sums),
    ) / 20
    central_second = second - volume * np.outer(center, center)
    inertia = np.trace(central_second) * np.eye(3) - central_second
    if not np.all(np.isfinite(center)) or not np.all(np.isfinite(inertia)):
        raise ValueError("solid mesh mass moments must be finite")
    return volume, center + origin, (inertia + inertia.T) / 2


def mass_properties(mesh: TriangularMesh, density: float) -> MassProperties:
    """Integrate mass, COM and full central inertia; cavities retain their sign.

    Surface triangles form signed tetrahedra about a nearby numerical origin.
    Their degree-two moments are exact for the represented polyhedral solid;
    curved-geometry error is controlled independently by its meshing profile.
    """
    if not np.isfinite(density) or density <= 0:
        raise ValueError("solid mass density must be finite and positive")
    volume, center, inertia = _surface_moments(mesh)
    mass, inertia = density * volume, density * inertia
    if volume <= 0 or not np.isfinite(mass) or not np.all(np.isfinite(inertia)):
        raise ValueError("solid mesh must have finite positive mass and outward orientation")
    if np.any(np.linalg.eigvalsh(inertia) <= 0):
        raise ValueError("solid mesh central inertia must be positive definite")
    return MassProperties(float(mass), center, inertia, volume)


def solid_component_identity(mesh: TriangularMesh) -> str:
    """Content identity independent of vertex/triangle order and cyclic winding.

    Identity belongs to this frozen tessellated geometry, not to a guessed
    correspondence after a vars/topology or meshing-profile change.
    """
    vertices = np.asarray(mesh.vertices[mesh.triangles], dtype=np.float64).reshape(-1, 3).copy()
    vertices[vertices == 0] = 0.0
    vertices, inverse = np.unique(vertices, axis=0, return_inverse=True)
    faces = inverse.reshape(-1, 3)
    first = np.argmin(faces, axis=1)
    faces = np.take_along_axis(faces, (first[:, None] + np.arange(3)) % 3, axis=1)
    ordered = sorted(
        (int(face[0]), int(face[1]), int(face[2]), p.root_id, p.source_node_id, p.surface_index)
        for face, p in zip(faces, mesh.triangle_provenance, strict=True)
    )
    return ContentKey.from_parts("geometry.solid-component-v1", vertices, ordered).digest


def _contains_boundary_point(mesh: TriangularMesh, point: np.ndarray) -> bool:
    # A face-interior point is on the candidate cavity boundary, not its COM:
    # a cavity COM can lie inside an independent nested material island.
    vectors = mesh.vertices[mesh.triangles] - point
    lengths = np.linalg.norm(vectors, axis=2)
    numerator = np.einsum("ni,ni->n", vectors[:, 0], np.cross(vectors[:, 1], vectors[:, 2]))
    denominator = np.prod(lengths, axis=1)
    for first, second, third in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
        denominator += np.einsum("ni,ni->n", vectors[:, first], vectors[:, second]) * lengths[:, third]
    return abs(float(np.sum(2 * np.arctan2(numerator, denominator)))) > 2 * np.pi


def components_from_shells(shells: Sequence[TriangularMesh]) -> tuple[SolidComponent, ...]:
    """Group disconnected boundary shells into connected material components."""
    if not shells:
        raise ValueError("canonical geometry does not contain a nonempty solid")
    volumes = np.asarray([_surface_moments(mesh)[0] for mesh in shells])
    positive = np.flatnonzero(volumes > 0)
    if not len(positive):
        raise ValueError("canonical geometry has no outward-oriented solid boundary")
    groups = {int(index): [int(index)] for index in positive}
    for index in np.flatnonzero(volumes < 0):
        cavity = shells[index]
        representative = np.mean(cavity.vertices[cavity.triangles[0]], axis=0)
        owners = [int(candidate) for candidate in positive
                  if _contains_boundary_point(shells[candidate], representative)]
        if not owners:
            raise ValueError("canonical cavity boundary has no containing solid")
        groups[min(owners, key=lambda owner: volumes[owner])].append(int(index))

    components = []
    for indices in groups.values():
        meshes = [shells[index] for index in indices]
        offsets = np.cumsum([0, *(len(mesh.vertices) for mesh in meshes[:-1])])
        mesh = TriangularMesh(
            np.concatenate([part.vertices for part in meshes]),
            np.concatenate([part.triangles + offset for part, offset in zip(meshes, offsets, strict=True)]),
            tuple(p for part in meshes for p in part.triangle_provenance),
        )
        mass_properties(mesh, 1.0)
        components.append(SolidComponent(solid_component_identity(mesh), mesh))
    return tuple(sorted(components, key=lambda component: component.identity))
