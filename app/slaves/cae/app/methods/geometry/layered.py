"""Conforming tetrahedra for canonical solids extruded along a common axis.

Planar atoms are shared by every layer. A globally ordered prism split makes
adjacent prisms share the same diagonal; no material thickness is approximated.
"""

import manifold3d as manifold
import numpy as np

from app.methods.mesh.models import TetrahedralMeshQuality
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
    determinants = np.linalg.det(points[cells[:, 1:]] - points[cells[:, :1]])
    inverted = determinants < 0
    cells[inverted, 1], cells[inverted, 2] = cells[inverted, 2].copy(), cells[inverted, 1].copy()
    volumes = np.abs(determinants) / 6
    lengths = sum(np.sum((points[cells[:, a]] - points[cells[:, b]])**2, axis=1) for a in range(4) for b in range(a))
    ratios = 12 * (3 * volumes)**(2 / 3) / lengths
    if np.min(ratios) < profile.minimum_quality:
        raise ValueError("layered mesh does not meet minimum_quality")
    # Match only material/exterior faces to their original canonical triangles.
    owners = {}
    for index, tet in enumerate(cells):
        for face in ((tet[0], tet[2], tet[1]), (tet[0], tet[1], tet[3]), (tet[0], tet[3], tet[2]), (tet[1], tet[2], tet[3])):
            owners.setdefault(tuple(sorted(face)), []).append((index, face))
    faces, provenance = [], []
    for adjacent in owners.values():
        regions = [int(cell_regions[index]) for index, _ in adjacent]
        if len(adjacent) == 2 and regions[0] == regions[1]:
            continue
        if len(adjacent) > 2:
            raise ValueError("layered mesh has a nonmanifold face")
        adjacent.sort(key=lambda item: cell_regions[item[0]])
        face = adjacent[0][1]
        center = points[list(face)].mean(axis=0)
        aliases = []
        for index, _ in adjacent:
            mesh = meshes[int(cell_regions[index])]
            coordinates = mesh.vertices[mesh.triangles]
            first, e1, e2 = coordinates[:, 0], coordinates[:, 1] - coordinates[:, 0], coordinates[:, 2] - coordinates[:, 0]
            normal = np.cross(e1, e2)
            lengths_n = np.linalg.norm(normal, axis=1)
            delta = center - first
            candidates = np.flatnonzero(np.abs(np.einsum("ij,ij->i", delta, normal)) <= tolerance * lengths_n)
            found = None
            for candidate in candidates:
                weights = np.linalg.lstsq(np.stack((e1[candidate], e2[candidate]), axis=1), delta[candidate], rcond=None)[0]
                if min(weights) >= -1e-8 and sum(weights) <= 1 + 1e-8:
                    found = mesh.triangle_provenance[candidate]
                    break
            if found is None:
                raise ValueError(f"layered boundary lost its canonical surface provenance: {center}, region {region_ids[int(cell_regions[index])]}")
            aliases.append(found)
        faces.append(face)
        provenance.append(tuple(aliases))
    node_regions = [set() for _ in points]
    interfaces = [set() for _ in points]
    for tet, region in zip(cells, cell_regions, strict=True):
        for vertex in tet:
            node_regions[vertex].add(int(region))
    for adjacent in owners.values():
        if len(adjacent) == 2:
            pair = tuple(int(cell_regions[index]) for index, _ in adjacent)
            if pair[0] != pair[1]:
                for vertex in adjacent[0][1]:
                    interfaces[vertex].add(pair)
    for regions, edges in zip(node_regions, interfaces, strict=True):
        connected = {next(iter(regions))}
        for _ in regions:
            for a, b in edges:
                if a in connected or b in connected:
                    connected.update((a, b))
        if connected != regions:
            raise ValueError("layered material regions must meet across faces, not only edges or points")
    return VolumeMesh(points, cells, np.asarray(faces, dtype=np.int64), tuple(provenance), tuple(region_ids), cell_regions, TetrahedralMeshQuality(volumes, ratios))
