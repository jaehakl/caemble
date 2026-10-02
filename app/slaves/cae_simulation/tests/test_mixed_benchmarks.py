"""Independent finite-bending and radial BVP references, at fixed shear modulus."""

import numpy as np
import pytest
from numpy.polynomial.legendre import leggauss
from scipy.integrate import solve_bvp

from app.solvers.structural_mechanics.analyses import mixed_static
from app.solvers.structural_mechanics.meshing import brick_mesh
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.solid_fields import evaluate_solid
from app.methods.finite_element.tetrahedron import tetrahedron_quadrature


pytestmark = pytest.mark.validation


SPLIT = np.array([[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]])


def make_model(points, cells, poisson):
    vertices = points[cells]
    negative = np.linalg.det((vertices[:, 1:]-vertices[:, :1]).swapaxes(1, 2)) < 0
    cells[negative] = cells[negative][:, [1, 0, 2, 3]]
    material = {'model': 'mechanics.compressible-neo-hookean@1', 'shear': 1000., 'lame': 2000*poisson/(1-2*poisson), 'density': 1.}
    elements = [Element('tet4', cell, material) for cell in cells]
    model = StructuralModel(np.arange(len(points)), points, elements,
                            (6*np.arange(len(points))[:, None]+np.arange(3)).ravel(), np.array([], dtype=int), np.zeros((len(points), 6)))
    model.solid_formulation = 'mixed-mini'
    return model


def boundary_faces(points, cells):
    faces = {}
    for cell in cells:
        for slots in ([1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]):
            face = cell[list(slots)]
            key = tuple(sorted(face))
            if key in faces:
                faces[key] = None
            else:
                faces[key] = face
    return np.asarray([face for face in faces.values() if face is not None])


def triangle_rule():
    x, w = leggauss(5)
    x, w = (x+1)/2, w/2
    a, b = np.meshgrid(x, x, indexing='ij')
    return np.stack((1-a, a*(1-b), a*b), axis=-1).reshape(-1, 3), (w[:, None]*w[None, :]*a).ravel()


def bending_exact(points):
    """J=1 bending map; body force follows -mu Laplacian(phi) by Piola identity."""
    x, y, z = points.T
    curvature, mu = .6, 1000.
    stretch = np.sqrt(1+2*curvature*x)
    cosine, sine = np.cos(curvature*y), np.sin(curvature*y)
    position = np.column_stack(((stretch*cosine-1)/curvature, stretch*sine/curvature, z))
    f = np.zeros((len(points), 3, 3))
    f[:, 0, 0], f[:, 1, 0] = cosine/stretch, sine/stretch
    f[:, 0, 1], f[:, 1, 1], f[:, 2, 2] = -stretch*sine, stretch*cosine, 1
    piola = mu*(f-np.linalg.inv(f).swapaxes(1, 2))
    stress = mu*(f @ f.swapaxes(1, 2)-np.eye(3))
    body = mu*curvature*(stretch**-3+stretch)[:, None]*np.column_stack((cosine, sine, np.zeros(len(points))))
    energy = mu/2*(np.sum(f*f, axis=(1, 2))-3)
    return position-points, piola, stress, body, energy


def bending_problem(refinement, poisson):
    points, bricks = brick_mesh([-.25, 0., 0.], [.5, 1., .2], [refinement, 2*refinement, max(1, refinement//2)])
    cells = bricks[:, SPLIT].reshape(-1, 4)
    model = make_model(points, cells, poisson)
    # Prescribe both ends of the manufactured bend; the four side faces remain
    # traction boundaries; interior displacement, pressure and volume response
    # remain unknown and must converge to the manufactured reference.
    fixed_nodes = np.flatnonzero(np.isclose(points[:, 1], 0) | np.isclose(points[:, 1], 1))
    model.fixed = (6*fixed_nodes[:, None]+np.arange(3)).ravel()
    model.prescribed = dict(zip(model.fixed, bending_exact(points[fixed_nodes])[0].ravel(), strict=True))
    prepared = mixed_static.prepare_mixed(model)
    body_bubble = np.zeros((len(cells), 3))
    bary, _ = tetrahedron_quadrature()
    for index, cell in enumerate(cells):
        body = bending_exact(bary @ points[cell])[3]
        forces = np.einsum('g,ga,gi->ai', prepared['weights'][index], prepared['shape'][index], body)
        np.add.at(model.force[:, :3], cell, forces[:4])
        body_bubble[index] = forces[4]
    shape, weights = triangle_rule()
    exact_reaction = np.zeros(3)
    for face in boundary_faces(points, cells):
        triangle = points[face]
        normal = np.cross(triangle[1]-triangle[0], triangle[2]-triangle[0])
        piola = bending_exact(shape @ triangle)[1]
        traction = np.einsum('gij,j->gi', piola, normal)
        forces = np.einsum('g,ga,gi->ai', weights, shape, traction)
        if np.all(np.isclose(triangle[:, 1], 0)) or np.all(np.isclose(triangle[:, 1], 1)):
            exact_reaction += forces.sum(axis=0)
        else:
            np.add.at(model.force[:, :3], face, forces)
    prepared['external'] = model.force.ravel().copy()
    prepared['bubbleExternal'] = body_bubble
    return model, prepared, exact_reaction


@pytest.mark.parametrize('poisson', [.3, .49, .499, .4999])
def test_nonuniform_finite_bending_converges_without_volumetric_locking(poisson, monkeypatch, record_property):
    errors = []
    prepare = mixed_static.prepare_mixed
    for refinement in (3, 6, 12):
        monkeypatch.setattr(mixed_static, 'prepare_mixed', prepare)
        model, prepared, exact_reaction = bending_problem(refinement, poisson)
        monkeypatch.setattr(mixed_static, 'prepare_mixed', lambda _model: prepared)
        solution = mixed_static.mixed_static_analysis(model)
        numerator = np.zeros(3)
        norm_u = exact_energy = volume = 0.
        bary, _ = tetrahedron_quadrature()
        for index, element in enumerate(model.elements):
            weights = prepared['weights'][index]
            exact_u, _, exact_stress, _, energy = bending_exact(bary @ model.points[element.nodes])
            fields = evaluate_solid(model, solution, index, bary)
            difference = fields['cauchyStress']-exact_stress
            numerator += [weights @ np.sum((fields['displacement']-exact_u)**2, axis=1),
                          weights @ np.sum(difference**2, axis=(1, 2)), weights @ (np.trace(difference, axis1=1, axis2=2)/3)**2]
            norm_u += weights @ np.sum(exact_u**2, axis=1)
            exact_energy += weights @ energy
            volume += weights.sum()
        reaction_error = np.linalg.norm(solution.reaction[:, :3].sum(axis=0)-exact_reaction)/np.linalg.norm(exact_reaction)
        row = [np.sqrt(numerator[0]/norm_u), np.sqrt(numerator[1]/volume)/1000, np.sqrt(numerator[2]/volume)/1000,
               abs(solution.equilibrium_energy/exact_energy-1), reaction_error]
        errors.append(row)
    record_property('fixed_mu_bending_errors', np.asarray(errors).tolist())
    assert errors[-1][0] < errors[0][0]
    assert errors[-1][3] < errors[0][3]
    assert np.all(np.asarray(errors[-1]) < [.02, .05, .05, .02, .02]), errors


def radial_reference(poisson, pressure=100.):
    """Independent plane-strain radial equilibrium in reference radius, using SciPy BVP."""
    mu, lame = 1000., 2000*poisson/(1-2*poisson)

    def stress(radius, current, derivative):
        stretch = current/radius
        logarithm = np.log(derivative*stretch)
        coefficient = lame*logarithm-mu
        return mu*derivative+coefficient/derivative, mu*stretch+coefficient/stretch, logarithm

    def equation(radius, state):
        current, derivative = state
        rr, tt, logarithm = stress(radius, current, derivative)
        partial_derivative = mu+(lame*(1-logarithm)+mu)/derivative**2
        second = (-(rr-tt)/radius-lame/current+lame/(derivative*radius))/partial_derivative
        return np.vstack((derivative, second))

    def boundary(a, b):
        return np.array([stress(.3, a[0], a[1])[0]+pressure*a[0]/.3, stress(.5, b[0], b[1])[0]])

    radius = np.linspace(.3, .5, 80)
    result = solve_bvp(equation, boundary, radius, np.vstack((radius, np.ones_like(radius))), tol=1e-9, max_nodes=5000)
    assert result.success, result.message
    return result


def cylinder_problem(refinement, poisson):
    radius, theta, axial = np.meshgrid(np.linspace(.3, .5, refinement+1), np.linspace(0, np.pi/2, 2*refinement+1), [0., .2], indexing='ij')
    points = np.column_stack((radius.ravel()*np.cos(theta.ravel()), radius.ravel()*np.sin(theta.ravel()), axial.ravel()))
    ids = np.arange(len(points)).reshape(radius.shape)
    bricks = []
    for i in range(refinement):
        for j in range(2*refinement):
            bricks.append([ids[i,j,0], ids[i+1,j,0], ids[i+1,j+1,0], ids[i,j+1,0], ids[i,j,1], ids[i+1,j,1], ids[i+1,j+1,1], ids[i,j+1,1]])
    cells = np.asarray(bricks)[:, SPLIT].reshape(-1, 4)
    model = make_model(points, cells, poisson)
    model.fixed = np.unique(np.r_[6*np.flatnonzero(np.isclose(points[:, 0], 0)), 6*np.flatnonzero(np.isclose(points[:, 1], 0))+1, 6*np.arange(len(points))+2])
    model.prescribed = dict.fromkeys(model.fixed, 0.)
    faces = boundary_faces(points, cells)
    inner = faces[np.all(np.isclose(np.linalg.norm(points[faces, :2], axis=-1), .3), axis=1)]
    model.follower_pressures = [(inner, 100.)]
    return model


@pytest.mark.parametrize('poisson', [.3, .49, .499, .4999])
def test_follower_cylinder_converges_to_independent_radial_bvp(poisson, record_property):
    reference = radial_reference(poisson)
    mu, lame = 1000., 2000*poisson/(1-2*poisson)
    locations, weights = leggauss(100)
    radial_points, radial_weights = .4+.1*locations, .1*weights
    current, derivative = reference.sol(radial_points)
    stretch = current/radial_points
    logarithm = np.log(derivative*stretch)
    density = mu/2*(derivative**2+stretch**2-2)-mu*logarithm+lame/2*logarithm**2
    exact_energy = np.pi/2*.2*np.dot(radial_weights*radial_points, density)
    side_reaction = -100.*reference.sol(.3)[0]*.2
    exact_reactions = np.array([side_reaction, side_reaction,
                               np.pi/2*np.dot(radial_weights*radial_points, lame*logarithm)])
    errors = []
    energy_gaps = []
    for refinement in (2, 4, 8):
        model = cylinder_problem(refinement, poisson)
        solution = mixed_static.mixed_static_analysis(model)
        radius = np.linalg.norm(model.points[:, :2], axis=1)
        expected = reference.sol(radius)[0]-radius
        radial_u = np.sum(model.points[:, :2]*solution.displacement[:, :2], axis=1)/radius
        error = np.linalg.norm(radial_u-expected)/np.linalg.norm(expected)
        numerator = np.zeros(2)
        volume = 0.
        bary, integration_weights = tetrahedron_quadrature()
        for index, element in enumerate(model.elements):
            vertices = model.points[element.nodes]
            points = bary @ vertices
            radii = np.linalg.norm(points[:, :2], axis=1)
            current, derivative = reference.sol(radii)
            stretch = current/radii
            jacobian = derivative*stretch
            coefficient = lame*np.log(jacobian)-mu
            radial_stress = (mu*derivative**2+coefficient)/jacobian
            hoop_stress = (mu*stretch**2+coefficient)/jacobian
            axial_stress = (mu+coefficient)/jacobian
            radial = np.column_stack((points[:, :2]/radii[:, None], np.zeros(len(points))))
            hoop = np.column_stack((-radial[:, 1], radial[:, 0], np.zeros(len(points))))
            expected_stress = (radial_stress[:, None, None]*radial[:, :, None]*radial[:, None, :]
                               + hoop_stress[:, None, None]*hoop[:, :, None]*hoop[:, None, :])
            expected_stress[:, 2, 2] = axial_stress
            fields = evaluate_solid(model, solution, index, bary)
            difference = fields['cauchyStress']-expected_stress
            element_weights = integration_weights*np.linalg.det((vertices[1:]-vertices[0]).T)
            numerator += [element_weights @ np.sum(difference**2, axis=(1, 2)),
                          element_weights @ (np.trace(difference, axis1=1, axis2=2)/3)**2]
            volume += element_weights.sum()
        reactions = np.array([solution.reaction[np.isclose(model.points[:, 0], 0), 0].sum(),
                              solution.reaction[np.isclose(model.points[:, 1], 0), 1].sum(),
                              solution.reaction[np.isclose(model.points[:, 2], .2), 2].sum()])
        errors.append([error, *np.sqrt(numerator/volume)/mu,
                       abs(solution.equilibrium_energy/exact_energy-1),
                       np.linalg.norm(reactions-exact_reactions)/np.linalg.norm(exact_reactions)])
        energy_gaps.append(solution.strain_energy-solution.equilibrium_energy)
        assert energy_gaps[-1] >= -1e-10
        assert solution.residual < 1e-8
    record_property('fixed_mu_radial_errors', np.asarray(errors).tolist())
    record_property('strain_minus_equilibrium_energy', np.asarray(energy_gaps).tolist())
    assert errors[-1][0] < errors[1][0] < errors[0][0], errors
    assert np.all(np.asarray(errors[-1]) < [.02, .05, .05, .02, .02]), errors
