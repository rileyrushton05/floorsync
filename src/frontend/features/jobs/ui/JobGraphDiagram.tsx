import { formatDuration } from "@/domains/scheduling/format";
import { levelGroups, type PrecedenceNode } from "../model/dependencies";

/** One operation as the diagram needs it: identity, a label, and what it costs. */
export interface GraphOperation extends PrecedenceNode {
    name: string;
    /** Minutes on its first listed machine, or null when it has no route yet. */
    durationMins: number | null;
    machineCount: number;
}

const NODE_WIDTH = 176;
const NODE_HEIGHT = 58;
const GAP_X = 20;
const GAP_Y = 46;
const PADDING = 10;
/** Width reserved for one detour lane beside the diagram. */
const LANE_WIDTH = 18;
const LANE_MARGIN = 10;
/** How far a detour eases out of a node before running straight down. */
const CORNER = 16;

/**
 * The job's precedence graph, flowing top to bottom, with each step a button.
 *
 * Rows are dependency depth — `1 + max(depth of predecessors)` — so everything
 * sharing a row is mutually independent and could run at once. That is the
 * whole reason to draw this rather than list the steps: a list can only show
 * one order, and the point of a graph is that some steps have none relative to
 * each other. Each row is centred so the shape reads as a tree.
 *
 * Nodes are real HTML buttons positioned over an SVG that draws only the edges.
 * Text in SVG cannot wrap or ellipsise and an `<svg>` element is a poor button:
 * this way selection, hover and keyboard focus are ordinary DOM behaviour, and
 * the labels truncate with CSS instead of a character count that guesses.
 *
 * It is a picture of precedence, not a schedule. A row says "cannot start
 * before", never "starts at" — machine contention is the scheduler's business,
 * and letting a row imply a start time would make it mean two things at once.
 *
 * The canvas scrolls in both directions inside a fixed viewport. A benchmark
 * job runs to fifty steps, and laid out at full height that is a card several
 * thousand pixels tall with the step editor beside it pushed off screen — the
 * graph would grow until the thing it is drawn next to became unreachable.
 */
export function JobGraphDiagram({
    operations,
    selectedId,
    onSelect,
}: {
    operations: GraphOperation[];
    selectedId: string | null;
    /** `null` clears the selection — Escape, or a click on empty canvas. */
    onSelect: (operationId: string | null) => void;
}) {
    if (operations.length === 0) return null;

    const rows = levelGroups(operations) as GraphOperation[][];
    const rowOf = new Map<string, number>();
    rows.forEach((row, index) => row.forEach((operation) => rowOf.set(operation.id, index)));

    // An edge crossing more than one row would otherwise pass behind the boxes
    // between, which reads as though it ended at one of them — the graph then
    // states a dependency that does not exist. Those are routed out to a lane
    // beside the diagram instead, so a line only ever touches its own two nodes.
    const direct: [string, string][] = [];
    const detoured: [string, string][] = [];
    for (const operation of operations) {
        for (const before of operation.dependsOn) {
            const span = (rowOf.get(operation.id) ?? 0) - (rowOf.get(before) ?? 0);
            (span > 1 ? detoured : direct).push([before, operation.id]);
        }
    }

    const widestRow = Math.max(...rows.map((row) => row.length));
    const contentWidth = widestRow * NODE_WIDTH + (widestRow - 1) * GAP_X;

    // A detour leaves on whichever side its source already sits nearest, so
    // lines travel the shorter way round and the two sides stay balanced.
    const centre = contentWidth / 2;
    const lanes = new Map<string, { side: "left" | "right"; index: number }>();
    let leftCount = 0;
    let rightCount = 0;
    for (const [before, after] of detoured) {
        const sourceRow = rows[rowOf.get(before) ?? 0];
        const column = sourceRow.findIndex((operation) => operation.id === before);
        const rowWidth = sourceRow.length * NODE_WIDTH + (sourceRow.length - 1) * GAP_X;
        const sourceCentre = (contentWidth - rowWidth) / 2 + column * (NODE_WIDTH + GAP_X) + NODE_WIDTH / 2;
        const side = sourceCentre < centre ? "left" : "right";
        lanes.set(`${before}>${after}`, { side, index: side === "left" ? leftCount++ : rightCount++ });
    }
    const leftPad = leftCount > 0 ? leftCount * LANE_WIDTH + LANE_MARGIN : 0;
    const rightPad = rightCount > 0 ? rightCount * LANE_WIDTH + LANE_MARGIN : 0;

    const width = contentWidth + PADDING * 2 + leftPad + rightPad;
    const height = rows.length * NODE_HEIGHT + (rows.length - 1) * GAP_Y + PADDING * 2;

    // Place every node first; edges are drawn from the same map, so a line can
    // never disagree with the box it points at.
    const placed = new Map<string, { x: number; y: number }>();
    rows.forEach((row, rowIndex) => {
        const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * GAP_X;
        const startX = PADDING + leftPad + (contentWidth - rowWidth) / 2;
        row.forEach((operation, columnIndex) => {
            placed.set(operation.id, {
                x: startX + columnIndex * (NODE_WIDTH + GAP_X),
                y: PADDING + rowIndex * (NODE_HEIGHT + GAP_Y),
            });
        });
    });

    // Several edges converging on one node and all landing dead-centre stack
    // their arrowheads into one blob, hiding how many there are. Spread the
    // arrivals across the node's top edge instead.
    const arrivalOffset = new Map<string, number>();
    for (const operation of operations) {
        const total = operation.dependsOn.length;
        operation.dependsOn.forEach((before, index) => {
            arrivalOffset.set(`${before}>${operation.id}`, (NODE_WIDTH * (index + 1)) / (total + 1));
        });
    }

    function endpoints(before: string, after: string) {
        const from = placed.get(before);
        const to = placed.get(after);
        if (!from || !to) return null;
        return {
            startX: from.x + NODE_WIDTH / 2,
            startY: from.y + NODE_HEIGHT,
            endX: to.x + (arrivalOffset.get(`${before}>${after}`) ?? NODE_WIDTH / 2),
            endY: to.y,
        };
    }

    const paths: { key: string; d: string; active: boolean }[] = [];
    const touchesSelection = (before: string, after: string) =>
        selectedId !== null && (before === selectedId || after === selectedId);
    for (const [before, after] of direct) {
        const at = endpoints(before, after);
        if (!at) continue;
        const bend = Math.max(GAP_Y * 0.45, (at.endY - at.startY) * 0.45);
        paths.push({
            key: `${before}>${after}`,
            active: touchesSelection(before, after),
            d: `M ${at.startX} ${at.startY} C ${at.startX} ${at.startY + bend}, ${at.endX} ${at.endY - bend}, ${at.endX} ${at.endY}`,
        });
    }
    for (const [before, after] of detoured) {
        const at = endpoints(before, after);
        const lane = lanes.get(`${before}>${after}`);
        if (!at || !lane) continue;
        const laneX =
            lane.side === "left"
                ? PADDING + leftPad - LANE_MARGIN - lane.index * LANE_WIDTH
                : PADDING + leftPad + contentWidth + LANE_MARGIN + lane.index * LANE_WIDTH;
        paths.push({
            key: `${before}>${after}`,
            active: touchesSelection(before, after),
            d:
                `M ${at.startX} ${at.startY} ` +
                `C ${at.startX} ${at.startY + CORNER}, ${laneX} ${at.startY + CORNER}, ${laneX} ${at.startY + CORNER * 2} ` +
                `L ${laneX} ${at.endY - CORNER * 2} ` +
                `C ${laneX} ${at.endY - CORNER}, ${at.endX} ${at.endY - CORNER}, ${at.endX} ${at.endY}`,
        });
    }

    return (
        <div
            // Safe centring, not plain `justify-center`/`items-center`: a centred
            // flex item that outgrows its container overflows by equal amounts at
            // both ends, and a scroll container can never reach what sits past its
            // start edge. A graph taller than the viewport therefore lost its first
            // rows, and a wider one its leftmost columns, with no way to scroll
            // back. `safe` drops to start alignment the moment the canvas would
            // overflow, so small graphs stay centred and large ones stay reachable.
            className="scroll-rail flex max-h-[32rem] min-h-40 flex-col items-center-safe justify-center-safe overflow-auto rounded-xl border bg-muted p-4"
            // Clicking the canvas rather than a node clears the selection. The
            // nodes stop the event, so this only ever fires on empty space.
            onClick={() => onSelect(null)}
            onKeyDown={(event) => {
                if (event.key === "Escape") onSelect(null);
            }}
        >
            <div className="relative shrink-0" style={{ width, height }}>
                <svg
                    width={width}
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                    aria-hidden
                    className="absolute inset-0"
                >
                    <defs>
                        <marker
                            id="job-graph-arrow"
                            viewBox="0 0 10 10"
                            refX="8"
                            refY="5"
                            markerWidth="5"
                            markerHeight="5"
                            orient="auto-start-reverse"
                        >
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted-fg)" />
                        </marker>
                        <marker
                            id="job-graph-arrow-active"
                            viewBox="0 0 10 10"
                            refX="8"
                            refY="5"
                            markerWidth="5"
                            markerHeight="5"
                            orient="auto-start-reverse"
                        >
                            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-primary)" />
                        </marker>
                    </defs>

                    {paths.map((path) => (
                        <path
                            key={path.key}
                            d={path.d}
                            fill="none"
                            // Selecting a step lights the edges it is an end of, so
                            // what it waits on and what waits on it is readable
                            // without tracing lines by eye.
                            stroke={path.active ? "var(--color-primary)" : "var(--color-muted-fg)"}
                            strokeOpacity={path.active ? 0.9 : 0.5}
                            strokeWidth={path.active ? 2 : 1.5}
                            markerEnd={`url(#job-graph-arrow${path.active ? "-active" : ""})`}
                        />
                    ))}
                </svg>

                <ul className="contents list-none">
                    {operations.map((operation) => {
                        const at = placed.get(operation.id);
                        if (!at) return null;
                        const isStart = operation.dependsOn.length === 0;
                        const isSelected = operation.id === selectedId;
                        return (
                            <li key={operation.id}>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onSelect(operation.id);
                                    }}
                                    aria-pressed={isSelected}
                                    aria-label={describeNode(operation, operations)}
                                    style={{ left: at.x, top: at.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                                    className={`absolute flex flex-col justify-center overflow-hidden rounded-[10px] border bg-overlay ps-3.5 pe-3 text-left shadow-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${isSelected
                                        ? "border-primary ring-2 ring-primary"
                                        : isStart
                                            ? "border-primary/50 hover:border-primary/80"
                                            : "border-border hover:border-muted-fg/40"
                                        }`}
                                >
                                    {/* A step with nothing before it is where the job
                                        opens; the accent saves tracing every arrow
                                        back to find them. */}
                                    <span
                                        aria-hidden
                                        className={`absolute inset-y-2.5 start-0 w-[3px] rounded-full ${isStart ? "bg-primary" : "bg-border"
                                            }`}
                                    />
                                    <span className="truncate font-semibold text-[12.5px] text-fg">
                                        {operation.name || <span className="italic opacity-70">Untitled step</span>}
                                    </span>
                                    <span className="truncate text-[11px] text-muted-fg">
                                        {subtitle(operation)}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}

function subtitle(operation: GraphOperation): string {
    const duration = operation.durationMins === null ? "No route" : formatDuration(operation.durationMins);
    return operation.machineCount <= 1 ? duration : `${duration} · ${operation.machineCount} machines`;
}

/**
 * What a node says to a screen reader.
 *
 * The edges are drawn in an `aria-hidden` layer, so each button has to carry
 * its own place in the graph — otherwise the structure exists only as pixels.
 */
function describeNode(operation: GraphOperation, all: GraphOperation[]): string {
    const label = operation.name || "Untitled step";
    const nameOf = (id: string) => all.find((candidate) => candidate.id === id)?.name || "an untitled step";
    const after =
        operation.dependsOn.length === 0
            ? "starts immediately"
            : `runs after ${operation.dependsOn.map(nameOf).join(" and ")}`;
    return `${label}, ${after}. ${subtitle(operation)}. Select to edit.`;
}
