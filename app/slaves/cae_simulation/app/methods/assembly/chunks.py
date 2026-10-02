"""Balanced sparse assembly with only occupied rows in intermediate chunks."""

import numpy as np
from scipy import sparse


def element_chunk(entries, dofs, shape, *, block_size=1):
    # A negative index is an eliminated degree of freedom supplied by the
    # caller. Its prescribed-load contribution is assembled by that caller.
    if np.any(dofs < 0):
        rows = np.unique(dofs[dofs >= 0])
        local = np.searchsorted(rows, dofs)
        width = dofs.shape[1]
        selected = ((dofs[:, :, None] >= 0) & (dofs[:, None, :] >= 0)).ravel()
        matrix = sparse.csr_matrix((entries.ravel()[selected], (np.repeat(local.ravel(), width)[selected],
            np.tile(dofs, (1, width)).ravel()[selected])), shape=(len(rows), shape[1]))
    else:
        rows, local = np.unique(dofs, return_inverse=True)
        width = dofs.shape[1]
        matrix = sparse.csr_matrix((entries.ravel(), (np.repeat(local, width),
            np.tile(dofs, (1, width)).ravel())), shape=(len(rows), shape[1]))
    if block_size > 1:
        matrix = matrix.tobsr(blocksize=(block_size, block_size))
        rows = rows[::block_size] // block_size
    return rows, matrix


def _expand_rows(matrix, positions, row_count):
    counts = np.zeros(row_count, dtype=matrix.indptr.dtype)
    counts[positions] = np.diff(matrix.indptr)
    block_size = matrix.blocksize[0] if sparse.isspmatrix_bsr(matrix) else 1
    constructor = sparse.bsr_matrix if block_size > 1 else sparse.csr_matrix
    return constructor((matrix.data, matrix.indices, np.r_[0, np.cumsum(counts)]),
                       shape=(row_count * block_size, matrix.shape[1]))


def _add_chunks(first, second):
    rows = np.union1d(first[0], second[0])
    first_matrix = _expand_rows(first[1], np.searchsorted(rows, first[0]), len(rows))
    second_matrix = _expand_rows(second[1], np.searchsorted(rows, second[0]), len(rows))
    return rows, first_matrix + second_matrix


def sum_sparse_chunks(chunks, shape):
    levels = []
    for chunk in chunks:
        level = 0
        while level < len(levels) and levels[level] is not None:
            chunk = _add_chunks(levels[level], chunk)
            levels[level] = None
            level += 1
        if level == len(levels):
            levels.append(chunk)
        else:
            levels[level] = chunk
    result = None
    for index, chunk in enumerate(levels):
        levels[index] = None
        if chunk is not None:
            result = chunk if result is None else _add_chunks(result, chunk)
    if result is None:
        return sparse.csr_matrix(shape)
    block_size = result[1].blocksize[0] if sparse.isspmatrix_bsr(result[1]) else 1
    return _expand_rows(result[1], result[0], shape[0] // block_size)
