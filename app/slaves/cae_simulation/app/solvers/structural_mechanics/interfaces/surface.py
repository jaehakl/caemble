"""Reference exterior surfaces shared by physical harmonic and transient exports."""

import hashlib

import numpy as np

from app.kernel.api import UnstructuredMeshValue

from ..domain import surface_region


def physical_surface(model, targets):
    if model.physical_node_count is None or any(element.kind != "tet4" for element in model.elements):
        raise ValueError("surface motion requires solver-generated tet4 physical surfaces")
    targets = tuple(sorted(set(targets)))
    faces = {}
    for target in targets:
        for face in surface_region(model, target)["faces"]:
            key = tuple(sorted(map(int, face)))
            existing = faces.get(key)
            if existing is not None and not any(np.array_equal(face, np.roll(existing, offset)) for offset in range(3)):
                raise ValueError("surface selection contains the same face with opposite orientations")
            faces.setdefault(key, np.asarray(face, dtype=np.int32))
    if not faces:
        raise ValueError("surface motion requires a nonempty semantic surface selection")
    occurrences = {}
    for element in model.elements:
        for local in ((0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)):
            key = tuple(sorted(int(element.nodes[index]) for index in local))
            occurrences[key] = occurrences.get(key, 0) + 1
    if any(occurrences.get(key) != 1 for key in faces):
        raise ValueError("surface motion can export only exterior physical faces")
    selected_faces = np.asarray([faces[key] for key in sorted(faces)], dtype=np.int32)
    nodes, inverse = np.unique(selected_faces.ravel(), return_inverse=True)
    if np.any(nodes >= model.physical_node_count):
        raise ValueError("surface motion cannot contain auxiliary attachment nodes")
    identity = hashlib.sha256((model.identity + "\n" + "\n".join(targets)).encode("utf-8")).hexdigest()
    metadata = {
        "sourceModelIdentity": model.identity, "surfaceTargets": targets,
        "sourceMeshNodeIds": model.node_ids[nodes].astype(np.int32),
        "rootIds": tuple(sorted({root for target in targets for root in surface_region(model, target)["rootIds"]})),
        "configuration": "reference",
    }
    provenance = model.provenance.get("boundaryProvenance")
    if provenance is not None:
        original_faces = model.provenance["boundaryFaces"]
        lookup = {tuple(sorted(map(int, face))): index for index, face in enumerate(original_faces)}
        alias_indices, offsets = [], [0]
        for face in selected_faces:
            index = lookup[tuple(sorted(map(int, face)))]
            alias_indices.extend(range(int(provenance["offsets"][index]), int(provenance["offsets"][index + 1])))
            offsets.append(len(alias_indices))
        metadata["boundaryProvenance"] = {
            "offsets": np.asarray(offsets, dtype=np.int32),
            **{name: np.asarray(provenance[name])[alias_indices]
               for name in ("sources", "rootIds", "sourceNodeIds", "surfaceIndices")},
        }
    domain = UnstructuredMeshValue(
        model.points[nodes], {"tri3": inverse.reshape(-1, 3).astype(np.int32)}, "m", identity, metadata,
    )
    return domain, nodes
