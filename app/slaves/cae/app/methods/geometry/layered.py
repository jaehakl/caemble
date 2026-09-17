"""Conforming tetrahedra for canonical solids extruded along a common axis.

Planar atoms are shared by every layer. A globally ordered prism split makes
adjacent prisms share the same diagonal; no material thickness is approximated.
"""

import manifold3d as manifold
import numpy as np

from app.methods.mesh.models import TetrahedralMeshQuality
from app.methods.mesh.boundary import TET4_FACES, material_boundary_owners
from app.methods.mesh.tetrahedral import triangulate_planar_domains
from .models import VolumeMesh


def layered_volume_mesh(meshes, region_ids, profile):
    axis = profile.layer_axis
    # A cyclic permutation preserves outward winding and positive orientation.
    axes = [(axis + 1) % 3, (axis + 2) % 3, axis]
    vertices = [mesh.vertices[:, axes] for mesh in meshes]
    extent = np.ptp(np.concatenate(vertices), axis=0)
    scale = float(max(extent))
    # CrossSection Boolean operations use a fixed clipping grid. Work at a
    # larger coordinate scale, then normalize for Netgen, to retain thin MEMS
    # dimensions instead of quantizing them to that grid.
    section_scale = scale / 1e6
    tolerance = max(scale * 1e-10, np.finfo(float).eps * 128)
    solids = []
    for mesh, points in zip(meshes, vertices, strict=True):
        edges = points[mesh.triangles[:, 1:]] - points[mesh.triangles[:, :1]]
        normals = np.cross(edges[:, 0], edges[:, 1])
        normals /= np.linalg.norm(normals, axis=1)[:, None]
        if np.any((np.abs(normals[:, 2]) > 1e-8) & (np.abs(normals[:, 2]) < 1 - 1e-8)):
            raise ValueError("layered meshing requires faces parallel or perpendicular to the layer axis")
        solids.append(manifold.Manifold(manifold.Mesh64(
            np.array(points / section_scale, order="C"), np.array(mesh.triangles, dtype=np.uint64, order="C"),
        )))
    raw_levels = np.sort(np.concatenate([points[:, 2] for points in vertices]))
    levels = raw_levels[np.r_[True, np.diff(raw_levels) > tolerance]]
    # Each atom carries the material present in each physical slab.
    atoms = []
    for slab, (bottom, top) in enumerate(zip(levels, levels[1:])):
        for region, solid in enumerate(solids):
            section = solid.slice(float((bottom + top) / (2 * section_scale)))
            if section.is_empty():
                continue
            remaining, updated = section, []
            for polygon, coverage in atoms:
                overlap, difference = polygon ^ section, polygon - section
                if not difference.is_empty():
                    updated.append((difference, coverage))
                if not overlap.is_empty():
                    if slab in coverage:
                        raise ValueError("volume mesh roots must not have overlapping interiors")
                    updated.append((overlap, {**coverage, slab: region}))
                remaining = remaining - polygon
            if not remaining.is_empty():
                updated.append((remaining, {slab: region}))
            atoms = updated
    if not atoms:
        raise ValueError("layered assembly has no volume")
    contours = [tuple(np.asarray(p) / 1e6 for p in polygon.to_polygons()) for polygon, _ in atoms]
    sizes = dict(profile.region_max_element_sizes)
    planar_sizes = [min(sizes.get(region_ids[r], profile.max_element_size) for r in coverage.values()) / scale for _, coverage in atoms]
    plane, triangles, domains = triangulate_planar_domains(
        contours, np.empty((0, 2)), tolerance / scale,
        profile.max_element_size / scale, profile.grading, profile.optimization_steps,
        domain_max_element_sizes=planar_sizes,
    )
    plane *= scale
    divisions = dict(profile.layer_subdivisions)
    points, cells, cell_regions = [], [], []
    node_map = {}

    def node(index, height):
        key = (int(index), float(height))
        if key not in node_map:
            node_map[key] = len(points)
            points.append([*plane[index], height])
        return node_map[key]

    for slab, (bottom, top) in enumerate(zip(levels, levels[1:])):
        active_regions = {coverage[slab] for _, coverage in atoms if slab in coverage}
        count = max((divisions.get(region_ids[r], 1) for r in active_regions), default=1)
        heights = np.linspace(bottom, top, count + 1)
        for triangle, domain in zip(triangles, domains, strict=True):
            region = atoms[int(domain)][1].get(slab)
            if region is None:
                continue
            a, b, c = sorted(triangle)
            for low, high in zip(heights, heights[1:]):
                lo = [node(i, low) for i in (a, b, c)]
                hi = [node(i, high) for i in (a, b, c)]
                cells.extend(((lo[0], lo[1], lo[2], hi[2]), (lo[0], lo[1], hi[1], hi[2]), (lo[0], hi[0], hi[1], hi[2])))
                cell_regions.extend([region] * 3)
    points = np.asarray(points)[:, np.argsort(axes)]
    cells = np.asarray(cells, dtype=np.int64)
    cell_regions = np.asarray(cell_regions, dtype=np.int64)
    del node_map
    volumes, ratios = np.empty(len(cells)), np.empty(len(cells))
    for start in range(0, len(cells), 65536):
        selected = slice(start, start + 65536)
        block = cells[selected]
        determinants = np.linalg.det(points[block[:, 1:]] - points[block[:, :1]])
        inverted = determinants < 0
        block[inverted, 1], block[inverted, 2] = block[inverted, 2].copy(), block[inverted, 1].copy()
        volumes[selected] = np.abs(determinants) / 6
        lengths = sum(np.sum((points[block[:, a]] - points[block[:, b]])**2, axis=1) for a in range(4) for b in range(a))
        ratios[selected] = 12 * (3 * volumes[selected])**(2 / 3) / lengths
    if np.min(ratios) < profile.minimum_quality:
        raise ValueError("layered mesh does not meet minimum_quality")
    owners = material_boundary_owners(cells, cell_regions)
    faces = cells[owners[:, :1] // 4, TET4_FACES[owners[:, 0] % 4]]
    boundary_regions = np.where(owners < 0, -1, cell_regions[owners // 4])
    provenance = _boundary_provenance(points, faces, boundary_regions, meshes, region_ids, tolerance)
    # Only material interfaces can connect the memberships of a shared node.
    node_regions = np.zeros((len(points), len(meshes)), dtype=bool)
    for start in range(0, len(cells), 65536):
        selected = slice(start, start + 65536)
        node_regions[cells[selected], cell_regions[selected, None]] = True
    connected = np.zeros_like(node_regions)
    connected[np.arange(len(points)), np.argmax(node_regions, axis=1)] = True
    pairs = boundary_regions[boundary_regions[:, 1] >= 0]
    interface_nodes = [(a, b, np.unique(faces[np.all(boundary_regions == (a, b), axis=1)]))
                       for a, b in np.unique(pairs, axis=0)]
    for _ in meshes:
        for a, b, indices in interface_nodes:
            linked = indices[connected[indices, a] | connected[indices, b]]
            connected[linked, a] = connected[linked, b] = True
    if not np.array_equal(connected, node_regions):
        raise ValueError("layered material regions must meet across faces, not only edges or points")
    return VolumeMesh(points, cells, faces, provenance, tuple(region_ids), cell_regions, TetrahedralMeshQuality(volumes, ratios))


def _boundary_provenance(points, faces, regions, meshes, region_ids, tolerance):
    """Match batches of boundary centers to the first canonical triangle."""
    aliases = np.full(regions.shape, None, dtype=object)
    for region, mesh in enumerate(meshes):
        rows, sides = np.where(regions == region)
        for start in range(0, len(rows), 65536):
            selected = slice(start, start + 65536)
            centers = points[faces[rows[selected]]].mean(axis=1)
            matched = np.full(len(centers), -1, dtype=int)
            for index, coordinates in enumerate(mesh.vertices[mesh.triangles]):
                missing = np.flatnonzero(matched < 0)
                edges = coordinates[1:] - coordinates[:1]
                normal = np.cross(edges[0], edges[1])
                delta = centers[missing] - coordinates[0]
                on_plane = np.abs(delta @ normal) <= tolerance * np.linalg.norm(normal)
                candidates = missing[on_plane]
                weights = delta[on_plane] @ np.linalg.pinv(edges.T).T
                inside = (weights.min(axis=1) >= -1e-8) & (weights.sum(axis=1) <= 1 + 1e-8)
                matched[candidates[inside]] = index
            if np.any(matched < 0):
                raise ValueError(f"layered boundary lost its canonical surface provenance: region {region_ids[region]}")
            aliases[rows[selected], sides[selected]] = np.asarray(mesh.triangle_provenance, dtype=object)[matched]
    return tuple((first,) if second is None else (first, second) for first, second in aliases)
