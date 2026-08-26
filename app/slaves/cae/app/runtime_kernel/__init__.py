"""CAE runtime kernel packages.

The resident coordinator, child execution boundary, and run-scoped resource
stores live here.  Solver implementations are intentionally outside this
package and are only imported by invocation child processes.
"""

