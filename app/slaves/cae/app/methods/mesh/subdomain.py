"""An active volume subset retaining exact canonical assembly correspondence."""

from dataclasses import dataclass

import numpy as np

from app.kernel.api import ContentKey, UnstructuredMeshValue
from app.methods.finite_element.scalar import ScalarElements


@dataclass(frozen=True)
class VolumeSubdomain:
    assembly: object
    cell_ids: np.ndarray
    node_ids: np.ndarray
    node_lookup: np.ndarray
    field_domain: UnstructuredMeshValue
    elements: ScalarElements

    @classmethod
    def create(cls, assembly, identity, active_roots):
        regions = [assembly.region_ids.index(root) for root in active_roots]
        cell_ids = np.flatnonzero(np.isin(assembly.cell_region_ids, regions))
        if not len(cell_ids):
            raise ValueError("active volume domain has no cells")
        node_ids = np.unique(assembly.cells[cell_ids])
        lookup = np.full(len(assembly.points), -1, dtype=np.int64)
        lookup[node_ids] = np.arange(len(node_ids))
        cells = lookup[assembly.cells[cell_ids]]
        metadata = {"assemblyIdentity": identity, "parentCellIds": cell_ids,
                    "parentNodeIds": node_ids, "cellRegions": assembly.cell_region_ids[cell_ids],
                    "regionIds": assembly.region_ids}
        domain_identity = ContentKey.from_parts("volume-subdomain-v1", identity, tuple(sorted(active_roots))).digest
        domain = UnstructuredMeshValue(assembly.points[node_ids], {"tet4": cells}, "m", domain_identity, metadata)
        return cls(assembly, cell_ids, node_ids, lookup, domain, ScalarElements.prepare(domain.points, cells))

    def surface_faces(self, selectors, *, exterior=True):
        indices = set()
        active_regions = set(self.assembly.cell_region_ids[self.cell_ids])
        for selector in selectors:
            for index in self.assembly.boundary_face_indices(selector):
                aliases = self.assembly.boundary_provenance[index]
                sides = sum(self.assembly.region_ids.index(p.root_id) in active_regions for p in aliases)
                if sides == 1 or not exterior:
                    indices.add(int(index))
        faces = self.node_lookup[self.assembly.boundary_faces[sorted(indices)]]
        if not len(faces) or np.any(faces < 0):
            raise ValueError("boundary must select nonempty faces of the active domain")
        return faces


async def build_volume_subdomain(geometry, scene, assembly_roots, active_roots, profile, progress=None):
    roots = tuple(sorted(assembly_roots))
    if not set(active_roots).issubset(roots):
        raise ValueError("active material roots must belong to the meshed assembly")
    mesh = await geometry.volume_mesh(scene, roots, "m", profile, progress=progress)
    identity = ContentKey.from_parts("canonical-volume-assembly-v2", scene.get("meshHash", scene["geometryHash"]), roots,
                                     mesh.points, mesh.cells, mesh.cell_region_ids).digest
    return VolumeSubdomain.create(mesh, identity, active_roots)
