"""Bounded harmonic Ritz information local to one physical time step."""

import asyncio

import numpy as np
from scipy.linalg import eig, qr, solve_triangular


class PressureSubspace:
    """Retain at most eight pressure directions between Picard solves/restarts.

    A new instance belongs to each physical step, including every retry. It is
    private numerical workspace and never enters a checkpoint or observations.
    """

    def __init__(self):
        self._directions = []

    async def prepare(self, system, *, cancellation=None):
        """Construct S Uhat = Q using the current, unchanged Schur response.

        At most eight additional response actions prepare a Krylov cycle. These
        preconditioner actions do not count as physical pressure corrections.
        """
        columns, images = [], []
        for previous in self._directions:
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            vector = previous.copy()
            if not np.any(system.pressure_fixed):
                vector -= vector[0]
            norm = np.linalg.norm(vector)
            if not np.isfinite(norm) or norm == 0:
                continue
            vector /= norm
            _, flux, _ = system.response(vector)
            columns.append(vector[system.free])
            images.append((system.mesh.divergence @ flux)[system.free])
            await asyncio.sleep(0)
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if not columns:
            return None, None
        images, vectors = np.column_stack(images), np.column_stack(columns)
        orthogonal, triangular, pivots = qr(images, mode="economic", pivoting=True)
        threshold = np.finfo(float).eps * max(images.shape) * np.abs(triangular.diagonal()).max()
        rank = int(np.count_nonzero(np.abs(triangular.diagonal()) > threshold))
        if rank == 0:
            return None, None
        transformed = solve_triangular(triangular[:rank, :rank].T,
                                       vectors[:, pivots[:rank]].T, lower=True).T
        return orthogonal[:, :rank], transformed

    def capture(self, preconditioned, raw_hessenberg, count):
        """Keep slow harmonic Ritz modes of the actual Arnoldi relation.

        Hbar.T Hbar y = theta Hk.T y selects the smallest finite |theta|.
        Real and imaginary parts retain a real pressure space for complex pairs.
        A short final cycle leaves the previous useful subspace intact.
        """
        if count < 8:
            return
        hessenberg = raw_hessenberg[:count + 1, :count]
        eigenvalues, eigenvectors = eig(hessenberg.T @ hessenberg, hessenberg[:count].T)
        selected = []
        for index in np.argsort(np.abs(eigenvalues)):
            value = eigenvalues[index]
            if not np.isfinite(value) or value.imag < 0:
                continue
            vector = eigenvectors[:, index]
            vector = vector * np.exp(-1j * np.angle(vector[np.argmax(np.abs(vector))]))
            directions = [vector.real] if value.imag == 0 else [vector.real, vector.imag]
            if len(selected) + len(directions) > 8:
                continue
            for direction in directions:
                correction = preconditioned[:, :count] @ direction
                if np.linalg.norm(correction):
                    selected.append(correction)
            if len(selected) == 8:
                break
        if selected:
            self._directions = selected
