# Third-party notice: Netgen

The CAE volume-meshing adapter uses the separately distributed
`netgen-mesher` Python package, pinned at version 6.2.2606. Netgen is licensed
under the GNU Lesser General Public License version 2.1 only
(`LGPL-2.1-only`). The complete license text is provided in
`NETGEN_LICENSE.txt`.

Netgen 6.2.2606 source and copyright notices are available from the upstream
release:

https://github.com/NGSolve/netgen/tree/v6.2.2606

The Python package also depends on `netgen-occt` 7.8.1, which distributes
Open CASCADE Technology libraries under GNU LGPL version 2.1 with the Open
CASCADE exception version 1.0. This software therefore makes use of or is
based on facilities provided by the Open CASCADE Technology software. The
exception is reproduced in `OCCT_LGPL_EXCEPTION.txt`; the LGPL version 2.1
text is reproduced in `NETGEN_LICENSE.txt`.

Open CASCADE Technology 7.8.1 source is available from the upstream release:

https://github.com/Open-Cascade-SAS/OCCT/tree/V7_8_1

The Caemble adapter does not modify or incorporate Netgen or Open CASCADE
source code. Packaged distributions must retain these notices, the license
and exception texts, and the separately replaceable shared-library form
provided by the Python wheels.
