import { formatDuration } from "@/domains/scheduling/format";
import { levelGroups, type PrecedenceNode } from "../model/dependencies";
import { useCanvasZoom } from "./useCanvasZoom";

/** One operation as the diagram needs it: identity, a label, and what it costs. */
export interface GraphOperation extends PrecedenceNode {
    name: string;
    /** Minutes on its first listed machine, or null when it has no route yet. */
    durationMins: number | null;
    machineCount: number;
}

const NODE_WIDTH = 176;
const NODE_HEIGHT = 50;
/** Between columns: this is where the edges run, so it is the wider gap. */
const GAP_X = 56;
const GAP_Y = 10;
const PADDING = 10;
/** Height reserved for one detour lane above or below the diagram. */
const LANE_HEIGHT = 18;
const LANE_MARGIN = 10;
/** How far a detour eases out of a node before running straight across. */
const CORNER = 16;

/**
 * The job's precedence graph, flowing left to right, with each step a button.
 *
 * Columns are dependency depth — `1 + max(depth of predecessors)` — so
 * everything sharing a column is mutually independent and could run at once.
 * That is the whole reason to draw this rather than list the steps: a list can
 * only show one order, and the point of a graph is that some steps have none
 * relative to each other. Each column is centred so the shape reads as a tree.
 *
 * Left to right rather than top to bottom because a job is far deeper than it
 * is wide: a long chain laid out downward is a tall narrow strip that wastes
 * the page's width, while laid out across it reads like a timeline and only
 * ever asks for a horizontal scroll.
 *
 * Nodes are real HTML buttons positioned over an SVG that draws only the edges.
 * Text in SVG cannot wrap or ellipsise and an `<svg>` element is a poor button:
 * this way selection, hover and keyboard focus are ordinary DOM behaviour, and
 * the labels truncate with CSS instead of a character count that guesses.
 *
 * It is a picture of precedence, not a schedule. A column says "cannot start
 * before", never "starts at" — machine contention is the scheduler's business,
 * and letting a column imply a start time would make it mean two things at once.
 *
 * The canvas scrolls inside a viewport that fills the editor's spare height,
 * down to the bottom of the screen (with a floor, and a ceiling of most of the
 * screen). Its flex basis is zero, so the canvas never sizes it: a benchmark
 * job runs to fifty steps, which laid out at full size is several thousand
 * pixels across and would stretch the card and push the step editor away.
 * Scrolling the wheel over it zooms (Alt + +/- too), the same as the Gantt
 * chart, so a big job can be taken in whole and then read up close.
 */
export function JobGraphDiagram(props: JobGraphProps) {
    if (props.operations.length === 0) return null;
    return <JobGraphCanvas {...props} />;
}

interface JobGraphProps {
    operations: GraphOperation[];
    selectedId: string | null;
    /** `null` clears the selection — Escape, or a click on empty canvas. */
    onSelect: (operationId: string | null) => void;
}

/** The diagram proper; split out so its zoom hook never runs for an empty job. */
function JobGraphCanvas({ operations, selectedId, onSelect }: JobGraphProps) {
    const columns = levelGroups(operations) as GraphOperation[][];
    const columnOf = new Map<string, number>();
    columns.forEach((column, index) => column.forEach((operation) => columnOf.set(operation.id, index)));

    // An edge crossing more than one column would otherwise pass behind the
    // boxes between, which reads as though it ended at one of them — the graph
    // then states a dependency that does not exist. Those are routed out to a
    // lane above or below the diagram instead, so a line only ever touches its
    // own two nodes.
    const direct: [string, string][] = [];
    const detoured: [string, string][] = [];
    for (const operation of operations) {
        for (const before of operation.dependsOn) {
            const span = (columnOf.get(operation.id) ?? 0) - (columnOf.get(before) ?? 0);
            (span > 1 ? detoured : direct).push([before, operation.id]);
        }
    }

    const columnHeight = (count: number) => count * NODE_HEIGHT + (count - 1) * GAP_Y;
    const contentHeight = columnHeight(Math.max(...columns.map((column) => column.length)));

    // A detour leaves on whichever side its source already sits nearest, so
    // lines travel the shorter way round and the two sides stay balanced.
    const centre = contentHeight / 2;
    const lanes = new Map<string, { side: "top" | "bottom"; index: number }>();
    let topCount = 0;
    let bottomCount = 0;
    for (const [before, after] of detoured) {
        const sourceColumn = columns[columnOf.get(before) ?? 0];
        const row = sourceColumn.findIndex((operation) => operation.id === before);
        const sourceCentre =
            (contentHeight - columnHeight(sourceColumn.length)) / 2 + row * (NODE_HEIGHT + GAP_Y) + NODE_HEIGHT / 2;
        const side = sourceCentre < centre ? "top" : "bottom";
        lanes.set(`${before}>${after}`, { side, index: side === "top" ? topCount++ : bottomCount++ });
    }
    const topPad = topCount > 0 ? topCount * LANE_HEIGHT + LANE_MARGIN : 0;
    const bottomPad = bottomCount > 0 ? bottomCount * LANE_HEIGHT + LANE_MARGIN : 0;

    const width = columns.length * NODE_WIDTH + (columns.length - 1) * GAP_X + PADDING * 2;
    const height = contentHeight + PADDING * 2 + topPad + bottomPad;
    const { scale, viewportProps, canvasRef } = useCanvasZoom(width, height);

    // Place every node first; edges are drawn from the same map, so a line can
    // never disagree with the box it points at.
    const placed = new Map<string, { x: number; y: number }>();
    columns.forEach((column, columnIndex) => {
        const startY = PADDING + topPad + (contentHeight - columnHeight(column.length)) / 2;
        column.forEach((operation, rowIndex) => {
            placed.set(operation.id, {
                x: PADDING + columnIndex * (NODE_WIDTH + GAP_X),
                y: startY + rowIndex * (NODE_HEIGHT + GAP_Y),
            });
        });
    });

    // Several edges converging on one node and all landing dead-centre stack
    // their arrowheads into one blob, hiding how many there are. Spread the
    // arrivals down the node's left edge instead.
    const arrivalOffset = new Map<string, number>();
    for (const operation of operations) {
        const total = operation.dependsOn.length;
        operation.dependsOn.forEach((before, index) => {
            arrivalOffset.set(`${before}>${operation.id}`, (NODE_HEIGHT * (index + 1)) / (total + 1));
        });
    }

    function endpoints(before: string, after: string) {
        const from = placed.get(before);
        const to = placed.get(after);
        if (!from || !to) return null;
        return {
            startX: from.x + NODE_WIDTH,
            startY: from.y + NODE_HEIGHT / 2,
            endX: to.x,
            endY: to.y + (arrivalOffset.get(`${before}>${after}`) ?? NODE_HEIGHT / 2),
        };
    }

    const paths: { key: string; d: string; active: boolean }[] = [];
    const touchesSelection = (before: string, after: string) =>
        selectedId !== null && (before === selectedId || after === selectedId);
    for (const [before, after] of direct) {
        const at = endpoints(before, after);
        if (!at) continue;
        const bend = Math.max(GAP_X * 0.45, (at.endX - at.startX) * 0.45);
        paths.push({
            key: `${before}>${after}`,
            active: touchesSelection(before, after),
            d: `M ${at.startX} ${at.startY} C ${at.startX + bend} ${at.startY}, ${at.endX - bend} ${at.endY}, ${at.endX} ${at.endY}`,
        });
    }
    for (const [before, after] of detoured) {
        const at = endpoints(before, after);
        const lane = lanes.get(`${before}>${after}`);
        if (!at || !lane) continue;
        const laneY =
            lane.side === "top"
                ? PADDING + topPad - LANE_MARGIN - lane.index * LANE_HEIGHT
                : PADDING + topPad + contentHeight + LANE_MARGIN + lane.index * LANE_HEIGHT;
        paths.push({
            key: `${before}>${after}`,
            active: touchesSelection(before, after),
            d:
                `M ${at.startX} ${at.startY} ` +
                `C ${at.startX + CORNER} ${at.startY}, ${at.startX + CORNER} ${laneY}, ${at.startX + CORNER * 2} ${laneY} ` +
                `L ${at.endX - CORNER * 2} ${laneY} ` +
                `C ${at.endX - CORNER} ${laneY}, ${at.endX - CORNER} ${at.endY}, ${at.endX} ${at.endY}`,
        });
    }

    return (
        <div
            // Safe centring, not plain `justify-center`/`items-center`: a centred
            // flex item that outgrows its container overflows by equal amounts at
            // both ends, and a scroll container can never reach what sits past its
            // start edge. A graph wider than the viewport therefore lost its leftmost
            // columns, and a taller one its first rows, with no way to scroll
            // back. `safe` drops to start alignment the moment the canvas would
            // overflow, so small graphs stay centred and large ones stay reachable.
            //
            // `contain: inline-size` stops the canvas's width from becoming this
            // box's minimum width. Without it every ancestor up to the page grid
            // grows to fit the whole graph, so nothing ever overflows here and
            // the graph runs off the screen with no scrollbar at all.
            {...viewportProps}
            className="scroll-rail flex w-full min-w-0 min-h-32 sm:min-h-40 2xl:min-h-52 max-h-[60dvh] flex-[1_1_0] [contain:inline-size] flex-col items-center-safe justify-center-safe overflow-auto overscroll-x-contain rounded-xl border bg-muted p-2 sm:p-4"
            // Clicking the canvas rather than a node clears the selection. The
            // nodes stop the event, so this only ever fires on empty space.
            onClick={() => onSelect(null)}
            onKeyDown={(event) => {
                if (event.key === "Escape") onSelect(null);
            }}
        >
            {/* The outer box takes the scaled size, so scrolling and centring
                see the graph as it is drawn; the inner one keeps the natural
                layout and is scaled from its corner. */}
            <div
                ref={canvasRef}
                className="relative shrink-0"
                style={{ width: width * scale, height: height * scale }}
            >
                <div
                    className="absolute top-0 left-0 origin-top-left"
                    style={{ width, height, transform: `scale(${scale})` }}
                >
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
