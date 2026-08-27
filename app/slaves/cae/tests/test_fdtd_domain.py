from __future__ import annotations

import math

import pytest

from app.solvers.fdtd.v1_0_0.domain import FDTDRegion, build_fdtd_domain


def test_main_is_ceil_expanded_around_its_fixed_center() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((-0.6, 0.6), (-1.1, 1.1), (-0.2, 0.2)), "main-material", "default"),
        (0.5, 1.0, 0.3),
        periodic=(True, True, True),
        pml_thickness=1.0,
        pml_cell_size=0.5,
    )

    assert domain.expanded_main_bounds == ((-0.75, 0.75), (-1.5, 1.5), (-0.3, 0.3))
    assert domain.topology.global_shape == (3, 3, 2)
    assert len(domain.topology.blocks) == 1
    assert domain.blocks[(0, 0, 0)].kind == "main"


def test_buffer_omits_zero_and_one_cell_sides_but_keeps_larger_gaps() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((-1.0, 1.0),) * 3, "main", "default"),
        (0.5, 0.5, 0.5),
        buffer=FDTDRegion(
            ((-1.0, 2.0), (-1.6, 1.6), (-2.1, 1.0)),
            "buffer",
            "Drude_RC",
        ),
        buffer_cell_size=0.6,
        periodic=(True, True, True),
        pml_thickness=1.0,
        pml_cell_size=0.5,
    )

    assert [segment.tag for segment in domain.topology.axes[0]] == ["main", "buffer"]
    assert [segment.tag for segment in domain.topology.axes[1]] == ["main"]
    assert [segment.tag for segment in domain.topology.axes[2]] == ["buffer", "main"]
    assert domain.core_bounds == ((-1.0, 2.2), (-1.0, 1.0), (-2.2, 1.0))
    assert sum(block.kind == "buffer" for block in domain.blocks.values()) == 3


def test_full_buffer_shell_has_at_most_twenty_six_blocks() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((-1.0, 1.0),) * 3, "main", "default"),
        (0.5, 0.5, 0.5),
        buffer=FDTDRegion(((-3.0, 3.0),) * 3, "buffer", "Drude_TRC"),
        buffer_cell_size=1.0,
        periodic=(True, True, True),
        pml_thickness=1.0,
        pml_cell_size=0.5,
    )

    assert len(domain.topology.blocks) == 27
    assert sum(block.kind == "main" for block in domain.blocks.values()) == 1
    assert sum(block.kind == "buffer" for block in domain.blocks.values()) == 26


def test_periodic_axes_do_not_receive_pml_segments() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((0.0, 1.0),) * 3, "main", "default"),
        (0.5, 0.5, 0.5),
        periodic=(True, False, True),
        pml_thickness=0.8,
        pml_cell_size=0.3,
    )

    assert [segment.tag for segment in domain.topology.axes[0]] == ["main"]
    assert [segment.tag for segment in domain.topology.axes[1]] == ["pml", "main", "pml"]
    assert [segment.tag for segment in domain.topology.axes[2]] == ["main"]
    assert domain.topology.axes[1][0].cell_count == math.ceil(0.8 / 0.3)
    assert domain.topology.axes[1][0].cell_size == pytest.approx(0.3)


def test_pml_inherits_nearest_core_background_and_model() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((-1.0, 1.0),) * 3, "main-bg", "default"),
        (0.5, 0.5, 0.5),
        buffer=FDTDRegion(
            ((-3.0, 1.4), (-1.0, 1.0), (-1.0, 1.0)),
            "buffer-bg",
            "Drude_RC",
        ),
        buffer_cell_size=1.0,
        periodic=(False, True, True),
        pml_thickness=1.0,
        pml_cell_size=0.5,
    )

    lower_pml = domain.blocks[(0, 0, 0)]
    upper_pml = domain.blocks[(3, 0, 0)]
    assert lower_pml.kind == "pml"
    assert lower_pml.inherited_from == (1, 0, 0)
    assert (lower_pml.background, lower_pml.model) == ("buffer-bg", "Drude_RC")
    assert upper_pml.kind == "pml"
    assert upper_pml.inherited_from == (2, 0, 0)
    assert (upper_pml.background, upper_pml.model) == ("main-bg", "default")


def test_pml_face_blocks_keep_the_core_tangential_grid() -> None:
    domain = build_fdtd_domain(
        FDTDRegion(((-1.0, 1.0),) * 3, "main", "default"),
        (0.5, 0.25, 0.2),
        buffer=FDTDRegion(((-3.0, 3.0),) * 3, "buffer", "Drude_RC"),
        buffer_cell_size=1.0,
        periodic=(False, False, False),
        pml_thickness=1.0,
        pml_cell_size=0.5,
    )

    face = domain.topology.block((0, 2, 2))
    adjacent = domain.topology.block(face.neighbors[(1, 0, 0)])
    assert face.segments[0].tag == "pml"
    assert adjacent.segments[0].tag == "buffer"
    assert face.global_slices[1:] == adjacent.global_slices[1:]
    assert face.cell_sizes[1:] == adjacent.cell_sizes[1:]
    assert face.cell_sizes[0] == pytest.approx(0.5)


def test_domain_rejects_invalid_bounds_buffer_containment_and_cell_sizes() -> None:
    with pytest.raises(ValueError, match="finite and increasing"):
        FDTDRegion(((0.0, 0.0), (0.0, 1.0), (0.0, 1.0)), "main", "default")

    main = FDTDRegion(((0.0, 1.1),) * 3, "main", "default")
    with pytest.raises(ValueError, match="expanded main"):
        build_fdtd_domain(
            main,
            (0.5, 0.5, 0.5),
            buffer=FDTDRegion(((0.0, 1.1),) * 3, "buffer", "default"),
            buffer_cell_size=0.6,
            pml_thickness=1.0,
            pml_cell_size=0.5,
        )
    with pytest.raises(ValueError, match="larger than every"):
        build_fdtd_domain(
            FDTDRegion(((0.0, 1.0),) * 3, "main", "default"),
            (0.5, 0.4, 0.3),
            buffer=FDTDRegion(((-1.0, 2.0),) * 3, "buffer", "default"),
            buffer_cell_size=0.5,
            pml_thickness=1.0,
            pml_cell_size=0.5,
        )
