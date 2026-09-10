"""BuiltMeasurement의 실제 절점·연결로 그리는 구조도. Viewer 화면이 아닙니다.

Matplotlib은 이 검증 그림에만 필요한 선택 의존성입니다. 저장소 루트에서 실행:
uv run --no-project --with matplotlib python app/slaves/cae/tests/fea_reference/plot_model.py
    --artifact .work/fea-turbine-final-v6 --out .work/fea-final-v6-evidence/turbine-model
위 명령의 두 줄은 한 줄로 이어서 입력합니다.

선의 굵기와 점 크기는 가독성을 위한 표시 속성입니다. 단면 치수나 변형량을
뜻하지 않습니다. 좌표, 요소 연결, 연결 조인트, 바다·해저 높이는 입력에서 읽고
재료·강성·하중 등의 물리 계수를 별도로 복사하지 않습니다.
"""

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.lines import Line2D
from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection


def value(item):
    return item["value"] if isinstance(item, dict) and "value" in item else item


def primitives(node, transform):
    """기존 CAD tree의 변환을 합성하여 이름이 있는 원시 형상을 찾습니다."""
    if node["kind"] == "primitive":
        yield node, transform
    if node["kind"] == "transform":
        transform = transform @ np.asarray(node["matrix"]).reshape(4, 4)
    if "child" in node:
        yield from primitives(node["child"], transform)
    for child in node.get("children", []):
        yield from primitives(child, transform)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument(
        "--out", type=Path, required=True, help="PNG/PDF/JSON의 공통 파일명"
    )
    args = parser.parse_args()
    manifest_path = args.artifact / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    item = next(item for item in manifest["items"] if item["index"] == 1)
    item_path = args.artifact / item["file"]
    payload_bytes = item_path.read_bytes()
    item_hash = hashlib.sha256(payload_bytes).hexdigest()
    if item_hash != item["input_hash"]:
        raise ValueError(
            "Built item bytes do not match its immutable artifact manifest"
        )
    measurement = json.loads(payload_bytes)["measurement"]
    experiment = measurement["experiment"]
    tasks = experiment["simulationProgram"]["tasks"]
    structure = tasks["structure"]["config"]
    initializations = structure["initializations"]
    node_rule = next(
        rule["parameters"]
        for rule in initializations
        if rule["methodId"] == "fea.nodes"
    )
    node_ids = np.asarray(value(node_rule["nodeIds"]), dtype=int)
    points = np.asarray(value(node_rule["positions"]), dtype=float)
    lookup = {int(node): row for row, node in enumerate(node_ids)}
    rotor = next(
        rule["parameters"]
        for rule in initializations
        if rule["methodId"] == "fea.rotor"
    )
    blades = np.asarray(value(rotor["bladeNodeIds"]), dtype=int)
    blade_sets = [set(map(int, nodes)) for nodes in blades]
    hub, nacelle, generator = (
        int(value(rotor[name])) for name in ["hubNode", "nacelleNode", "generatorNode"]
    )
    links = [
        (
            int(value(rule["parameters"]["master"])),
            int(value(rule["parameters"]["slave"])),
        )
        for rule in initializations
        if rule["methodId"] == "fea.rigid-link"
    ]
    mass_nodes = [
        int(value(rule["parameters"]["nodeId"]))
        for rule in initializations
        if rule["methodId"] == "fea.mass"
    ]
    cg_nodes = [
        slave for master, slave in links if master == nacelle and slave in mass_nodes
    ]
    tower_top = next(master for master, slave in links if slave == nacelle)

    blocks = [
        rule
        for rule in initializations
        if rule["methodId"] in ("fea.beam2", "fea.generalized-beam2")
    ]
    targets = sorted({target for block in blocks for target in block["target"]})
    # 이 예제의 해석 target은 body 하나이다. CAD 내부 primitive의 이름과
    # 높이 범위를 읽어 pile/tower를 구분하고, 블레이드는 rotor 절점 집합으로 찾는다.
    if len(targets) != 1 or not targets[0].startswith("experiment.geometry."):
        raise ValueError(
            "This reference figure expects one canonical experiment Geometry target"
        )
    root_id = targets[0].split(".", 2)[2]
    root = next(root for root in experiment["scene"]["roots"] if root["id"] == root_id)
    cad = {
        node["nodeId"]: (node, transform)
        for node, transform in primitives(root["node"], np.eye(4))
    }
    pile_cad, pile_transform = cad[f"{root_id}.pile"]
    tower_cad, tower_transform = cad[f"{root_id}.tower"]
    pile_height = pile_cad["parameters"]["height"]
    pile_ends = (
        np.array([[0.0, 0.0, -pile_height / 2, 1.0], [0.0, 0.0, pile_height / 2, 1.0]])
        @ pile_transform.T
    )
    pile_limits = np.sort(pile_ends[:, 2])
    tower_height = tower_cad["parameters"]["height"]
    tower_ends = (
        np.array(
            [[0.0, 0.0, -tower_height / 2, 1.0], [0.0, 0.0, tower_height / 2, 1.0]]
        )
        @ tower_transform.T
    )
    tower_limits = np.sort(tower_ends[:, 2])
    groups = {
        "pile": [],
        "tower": [],
        **{f"blade{i + 1}": [] for i in range(len(blades))},
    }
    grouped_ids = {key: [] for key in groups}
    for block in blocks:
        for connection in value(block["parameters"]["connectivity"]):
            rows = [lookup[int(node)] for node in connection]
            coordinates = points[rows]
            blade = next(
                (i for i, nodes in enumerate(blade_sets) if set(connection) <= nodes),
                None,
            )
            if blade is not None:
                group = f"blade{blade + 1}"
            elif np.all(
                (coordinates[:, 2] >= pile_limits[0] - 1e-8)
                & (coordinates[:, 2] <= pile_limits[1] + 1e-8)
            ):
                group = "pile"
            elif np.all(
                (coordinates[:, 2] >= tower_limits[0] - 1e-8)
                & (coordinates[:, 2] <= tower_limits[1] + 1e-8)
            ):
                group = "tower"
            else:
                raise ValueError(
                    "A support beam lies outside the source pile/tower Geometry bounds"
                )
            groups[group].append(coordinates)
            grouped_ids[group].append(connection)

    hydro = tasks["hydrodynamics"]["config"]["parameters"]
    sea_level = 0.0  # hydrodynamic-loading 공개 좌표 계약: z=0이 평균 수면.
    mudline = sea_level - float(value(hydro["waterDepth"]))
    font = next(
        (
            path
            for path in [
                Path("C:/Windows/Fonts/NanumGothic.ttf"),
                Path("C:/Windows/Fonts/malgun.ttf"),
            ]
            if path.exists()
        ),
        None,
    )
    korean = font is not None
    if font:
        font_manager.fontManager.addfont(str(font))
        plt.rcParams["font.family"] = font_manager.FontProperties(
            fname=str(font)
        ).get_name()
    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.unicode_minus": False,
            "pdf.fonttype": 42,
            "savefig.facecolor": "white",
        }
    )
    labels = (
        {
            "pile": "모노파일",
            "tower": "타워",
            "blade1": "블레이드 1",
            "blade2": "블레이드 2",
            "blade3": "블레이드 3",
        }
        if korean
        else {
            "pile": "Monopile",
            "tower": "Tower",
            "blade1": "Blade 1",
            "blade2": "Blade 2",
            "blade3": "Blade 3",
        }
    )
    colors = {
        "pile": "#68717b",
        "tower": "#245f98",
        "blade1": "#018c8c",
        "blade2": "#68a233",
        "blade3": "#ce762a",
    }
    figure = plt.figure(figsize=(13, 11), layout="constrained")
    grid = figure.add_gridspec(
        3, 2, width_ratios=[2.1, 1], height_ratios=[0.85, 0.7, 1.45]
    )
    main_axis = figure.add_subplot(grid[:, 0], projection="3d", proj_type="ortho")
    inset = figure.add_subplot(grid[0, 1])
    legend_axis = figure.add_subplot(grid[1, 1])
    legend_axis.axis("off")
    notes = figure.add_subplot(grid[2, 1])
    notes.axis("off")
    handles = []
    for name, segments in groups.items():
        main_axis.add_collection3d(
            Line3DCollection(segments, colors=colors[name], linewidths=3.2)
        )
        rows = np.unique(np.asarray(grouped_ids[name]).ravel())
        xyz = points[[lookup[int(node)] for node in rows]]
        main_axis.scatter(*xyz.T, s=8, c=colors[name], depthshade=False)
        handles.append(
            Line2D(
                [],
                [],
                color=colors[name],
                linewidth=3,
                label=f"{labels[name]} · {len(segments)} elements",
            )
        )
    connections = links + [(hub, int(node)) for node in value(rotor["bladeRootNodes"])]
    for master, slave in connections:
        xyz = points[[lookup[master], lookup[slave]]]
        main_axis.plot(*xyz.T, color="#373b40", linewidth=1.4, linestyle="--")
    shaft = points[[lookup[hub], lookup[generator]]]
    main_axis.plot(*shaft.T, color="#ab4372", linewidth=3)
    main_axis.scatter(
        *points[[lookup[node] for node in [hub, nacelle, *cg_nodes]]].T,
        color="#242a30",
        s=28,
        depthshade=False,
    )
    fixed = sorted(
        {
            int(node)
            for rule in structure["boundaryConditions"]
            if rule["methodId"] == "fea.fixed"
            for node in value(rule["parameters"]["nodeIds"])
        }
    )
    main_axis.scatter(
        *points[[lookup[node] for node in fixed]].T,
        marker="^",
        s=85,
        color="#302d29",
        depthshade=False,
    )
    for height, color, label in [
        (sea_level, "#69b9db", "수면" if korean else "Sea level"),
        (
            mudline,
            "#b6a18b",
            "해저 / 고정 지지" if korean else "Mudline / fixed support",
        ),
    ]:
        plane = np.array(
            [[-18, -60, height], [18, -60, height], [18, 60, height], [-18, 60, height]]
        )
        main_axis.add_collection3d(
            Poly3DCollection(
                [plane], facecolors=color, edgecolors=color, linewidths=0.6, alpha=0.15
            )
        )
        main_axis.text(
            -19,
            -61,
            height,
            f"{label}\nz = {height:.4f} m",
            fontsize=9,
            color="#375468",
        )
    main_axis.set(
        xlim=(-23, 23),
        ylim=(points[:, 1].min() - 12, points[:, 1].max() + 12),
        zlim=(min(mudline, points[:, 2].min()) - 10, points[:, 2].max() + 12),
        xlabel="X [m]",
        ylabel="Y [m]",
        zlabel="Z [m]",
    )
    main_axis.set_box_aspect(
        [
            np.ptp(main_axis.get_xlim()),
            np.ptp(main_axis.get_ylim()),
            np.ptp(main_axis.get_zlim()),
        ]
    )
    main_axis.view_init(elev=13, azim=-20)
    main_axis.xaxis.set_ticks([-20, 0, 20])
    main_axis.yaxis.set_ticks([-50, 0, 50])
    main_axis.zaxis.set_ticks([-20, 0, 50, 100, 150])
    for axis in [main_axis.xaxis, main_axis.yaxis, main_axis.zaxis]:
        axis.pane.fill = False
        axis._axinfo["grid"]["color"] = (0.7, 0.75, 0.8, 0.25)
    main_axis.set_title(
        "전체 기준 형상 · 실제 좌표 비율"
        if korean
        else "Full reference mesh · equal spatial scale",
        loc="left",
        pad=20,
    )

    # X-Z 확대도에서도 좌표를 옮기지 않는다. 발전기와 나셀 bearing은 실제로
    # 같은 위치에 있지만 서로 다른 기계적 자유도를 갖기 때문에 함께 표기한다.
    for master, slave in links:
        xyz = points[[lookup[master], lookup[slave]]]
        inset.plot(xyz[:, 0], xyz[:, 2], "--", color="#5e6872", linewidth=1.4)
    inset.plot(shaft[:, 0], shaft[:, 2], color="#ab4372", linewidth=3)
    annotations = [
        (hub, "허브" if korean else "Hub", (-10, 24)),
        (
            nacelle,
            "나셀 베어링 / 발전기" if korean else "Nacelle bearing / generator",
            (-5, 20),
        ),
        (tower_top, "타워 상단" if korean else "Tower top", (-5, -30)),
    ]
    annotations += [
        (node, "나셀 질량중심" if korean else "Nacelle center of mass", (-6, -36))
        for node in cg_nodes
    ]
    for node, label, offset in annotations:
        xyz = points[lookup[node]]
        inset.scatter(xyz[0], xyz[2], s=45, color="#233c50", zorder=5)
        ids = f"{nacelle}, {generator}" if node == nacelle else str(node)
        inset.annotate(
            f"{label}\nnode {ids}",
            (xyz[0], xyz[2]),
            xytext=offset,
            textcoords="offset points",
            fontsize=9,
            ha="center",
            arrowprops={"arrowstyle": "-", "color": "#768493"},
        )
    shaft_middle = shaft.mean(axis=0)
    inset.text(
        shaft_middle[0],
        shaft_middle[2] - 0.35,
        "탄성 구동축" if korean else "Elastic drivetrain",
        color="#96305f",
        ha="center",
        fontsize=9,
    )
    inset.set(xlabel="X [m]", ylabel="Z [m]", aspect="equal")
    inset.margins(x=0.24, y=0.95)
    inset.grid(alpha=0.18)
    inset.set_title(
        "허브·나셀·구동축 확대 (X–Z)"
        if korean
        else "Hub, nacelle and drivetrain (X–Z)",
        fontsize=12,
    )
    legend_axis.legend(
        handles=handles
        + [
            Line2D(
                [],
                [],
                color="#ab4372",
                linewidth=3,
                label="탄성 구동축" if korean else "Elastic drivetrain",
            ),
            Line2D(
                [],
                [],
                color="#5e6872",
                linestyle="--",
                label="강체 / pitch 연결" if korean else "Rigid / pitch links",
            ),
        ],
        loc="upper left",
        frameon=False,
        fontsize=10,
        labelspacing=0.85,
    )
    explanation = (
        f"절점 {len(points)}개 · 보 요소 {sum(map(len, groups.values()))}개\n"
        "선 = 보 중심선 / 점 = 실제 절점\n선 굵기와 점 크기는 표시용입니다.\n변형 후 형상이나 단면 외형이 아닙니다.\n\n"
        f"평균 수면: z = 0 m\n해저: z = {mudline:.4f} m\n"
        "수면은 수력 Solver의 좌표 계약,\n해저는 실제 waterDepth 입력에서 읽었습니다.\n\n"
        f"공통 Geometry target\n{targets[0]}\n"
        f"CAD 내부: {root_id}.pile / .tower / .blade0–2\n"
        "블레이드 연결: fea.rotor.bladeNodeIds\n\n"
        "과학적 모델 구조도 (Matplotlib)\n공유 Viewer의 화면 캡처가 아닙니다."
        if korean
        else f"{len(points)} nodes; {sum(map(len, groups.values()))} beam elements\nLines: centerlines; dots: actual nodes\nLine width is illustrative, not section size.\nReference geometry, not deformed response.\n\nSea level: 0 m (hydro coordinate contract)\nMudline from waterDepth: {mudline:.4f} m\n\nCanonical target: {targets[0]}\nCAD groups: .pile / .tower / .blade0–2\nBlade connectivity: fea.rotor.bladeNodeIds\n\nScientific Matplotlib model diagram.\nNot a shared Viewer screenshot."
    )
    notes.text(
        0.02,
        0.99,
        explanation,
        va="top",
        fontsize=9.2,
        linespacing=1.6,
        transform=notes.transAxes,
    )
    figure.suptitle(
        "NREL 5-MW + OC3 모노파일 · 구조 FEA 모델"
        if korean
        else "NREL 5-MW + OC3 monopile · structural FEA model",
        fontsize=18,
        fontweight="bold",
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for extension in ["png", "pdf"]:
        figure.savefig(
            args.out.with_suffix(f".{extension}"), dpi=220, bbox_inches="tight"
        )
    plt.close(figure)
    provenance = {
        "kind": "scientific-model-diagram",
        "artifact": str(args.artifact.resolve()),
        "artifactManifestSha256": hashlib.sha256(
            manifest_path.read_bytes()
        ).hexdigest(),
        "sourceHash": manifest["source_hash"],
        "catalogRevision": manifest["catalog_revision"],
        "inputSha256": item_hash,
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "matplotlibVersion": matplotlib.__version__,
        "font": str(font) if font else "DejaVu Sans",
        "nodeCount": len(points),
        "elementCount": sum(map(len, groups.values())),
        "geometryTargets": targets,
        "cadPrimitiveIds": sorted(cad),
        "groupConnectivity": grouped_ids,
        "seaLevel": sea_level,
        "mudline": mudline,
        "coordinates": "SI m; reference centerlines; original global frame",
        "files": {
            extension: hashlib.sha256(
                args.out.with_suffix(f".{extension}").read_bytes()
            ).hexdigest()
            for extension in ["png", "pdf"]
        },
    }
    args.out.with_suffix(".json").write_text(
        json.dumps(provenance, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "out": str(args.out),
                "nodeCount": len(points),
                "elementCount": provenance["elementCount"],
                "inputSha256": item_hash,
            }
        )
    )


if __name__ == "__main__":
    main()
