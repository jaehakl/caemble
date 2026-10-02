from __future__ import annotations

import numpy as np

from app.methods.assembly import SparseTriplets, TripletBuilder, assemble_element_matrices
from app.methods.fields import Field, FieldLocation
from app.methods.finite_difference import (
    apply_stencil,
    first_derivative_stencil,
    laplacian_stencil,
)
from app.methods.finite_element import DOFMap, DirichletConstraints, gauss_legendre, integrate_quadrature
from app.methods.linalg import DenseLinearOperator, conjugate_gradient, gmres, jacobi_preconditioner
from app.methods.mesh import EntityKind, EntitySet, UnstructuredMesh
from app.methods.nonlinear import newton, picard
from app.methods.structured import Box, Halo, Partition
from app.methods.time import TimeState, explicit_euler, implicit_euler, integrate


def test_box_composes_backend_neutral_fields_and_injected_operators() -> None:
    partition = Partition(shape=(5,), offset=(0,))
    halo = Halo(width=(1,), periodic=(False,))
    box = Box(partition, halo)
    source = box.add(Field("u", np.arange(-1.0, 6.0), FieldLocation.CELL, domain="line"))

    derivative = box.apply(
        lambda value: apply_stencil(
            value.field("u").values,
            first_derivative_stencil(0, 1.0, 1),
            value.halo.interior(value.partition),
        )
    )
    exchanges: list[tuple[Field, Partition, Halo]] = []
    box.exchange(lambda field, part, field_halo: exchanges.append((field, part, field_halo)))

    np.testing.assert_allclose(derivative, 1.0)
    assert exchanges == [(source, partition, halo)]
    assert source.with_values(source.values * 2).domain == "line"


def test_laplacian_stencil_operates_on_the_box_interior() -> None:
    coordinates = np.arange(-1.0, 6.0)
    result = apply_stencil(
        coordinates**2,
        laplacian_stencil((1.0,)),
        (slice(1, 6),),
    )

    np.testing.assert_allclose(result, 2.0)


def test_mesh_dof_map_and_tensor_quadrature_are_composable() -> None:
    boundary = EntitySet("wall", EntityKind.NODE, np.asarray([0, 2]))
    mesh = UnstructuredMesh(
        points=np.asarray([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]),
        cells=np.asarray([[0, 1, 2]]),
        cell_type="triangle",
        sets={boundary.name: boundary},
    )
    dofs = DOFMap.nodal(mesh.node_count, components=2)
    element_dofs = dofs.element_dofs(mesh.cells)
    rule = gauss_legendre(2, dimensions=2)

    assert mesh.cell_coordinates().shape == (1, 3, 2)
    assert element_dofs.tolist() == [[0, 1, 2, 3, 4, 5]]
    assert dofs.size == 6
    assert rule.points.shape == (4, 2)
    np.testing.assert_allclose(integrate_quadrature(np.full(4, 2.0), np.ones(4), rule), 8.0)


def test_triplet_assembly_accumulates_shared_element_entries() -> None:
    matrix = assemble_element_matrices(
        3,
        (np.asarray([0, 1]), np.asarray([1, 2])),
        (
            np.asarray([[1.0, -1.0], [-1.0, 1.0]]),
            np.asarray([[1.0, -1.0], [-1.0, 1.0]]),
        ),
    )

    np.testing.assert_allclose(
        matrix.to_dense(),
        [[1.0, -1.0, 0.0], [-1.0, 2.0, -1.0], [0.0, -1.0, 1.0]],
    )
    np.testing.assert_allclose(matrix.diagonal(), [1.0, 2.0, 1.0])
    np.testing.assert_allclose(matrix.matvec(np.ones(3)), 0.0)


def test_constraints_and_iterative_linear_solvers() -> None:
    dense = np.asarray([[4.0, 1.0], [1.0, 3.0]])
    rhs = np.asarray([1.0, 2.0])
    cg = conjugate_gradient(
        DenseLinearOperator(dense),
        rhs,
        preconditioner=jacobi_preconditioner(np.diag(dense)),
        tolerance=1e-12,
    )
    gmres_result = gmres(
        DenseLinearOperator(np.asarray([[3.0, 1.0], [0.0, 2.0]])),
        rhs,
        restart=2,
        tolerance=1e-12,
    )
    constrained_matrix, constrained_rhs = DirichletConstraints(
        np.asarray([0]),
        np.asarray([3.0]),
    ).apply_dense(np.asarray([[2.0, -1.0], [-1.0, 2.0]]), np.zeros(2))

    assert cg.converged
    assert gmres_result.converged
    np.testing.assert_allclose(cg.solution, np.linalg.solve(dense, rhs))
    np.testing.assert_allclose(
        gmres_result.solution,
        np.linalg.solve(np.asarray([[3.0, 1.0], [0.0, 2.0]]), rhs),
        atol=1e-15,
    )
    np.testing.assert_allclose(constrained_matrix, [[1.0, 0.0], [0.0, 2.0]])
    np.testing.assert_allclose(constrained_rhs, [3.0, 3.0])


def test_sparse_triplets_satisfy_the_linear_operator_protocol() -> None:
    builder = TripletBuilder((2, 2))
    builder.add_block(np.arange(2), np.arange(2), np.asarray([[2.0, -1.0], [-1.0, 2.0]]))
    matrix: SparseTriplets = builder.build()

    result = conjugate_gradient(matrix, np.asarray([1.0, 0.0]), tolerance=1e-12)

    assert result.converged
    np.testing.assert_allclose(result.solution, [2 / 3, 1 / 3])


def test_nonlinear_iterations_inject_problem_specific_steps() -> None:
    newton_result = newton(
        lambda value: value * value - 2.0,
        lambda value, residual: -residual / (2.0 * value),
        np.asarray([1.0]),
        tolerance=1e-12,
    )
    picard_result = picard(
        lambda value: 0.5 * (value + 2.0),
        np.asarray([0.0]),
        tolerance=1e-10,
    )

    assert newton_result.converged
    assert picard_result.converged
    np.testing.assert_allclose(newton_result.solution, np.sqrt(2.0), rtol=1e-12)
    np.testing.assert_allclose(picard_result.solution, 2.0, atol=1e-9)


def test_explicit_and_implicit_time_integrators_share_a_step_contract() -> None:
    initial = TimeState(0.0, np.asarray([1.0]))
    trajectory = integrate(
        lambda state, time_step: explicit_euler(lambda _time, value: value, state, time_step),
        initial,
        0.1,
        2,
    )
    implicit = implicit_euler(
        lambda _time, previous, time_step: previous / (1.0 - time_step),
        initial,
        0.1,
    )

    assert [state.time for state in trajectory] == [0.0, 0.1, 0.2]
    np.testing.assert_allclose(trajectory[-1].value, [1.21])
    np.testing.assert_allclose(implicit.value, [1.0 / 0.9])
