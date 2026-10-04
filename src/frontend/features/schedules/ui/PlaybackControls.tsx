import { Button } from "@/components/ui/button";
import { Keyboard } from "@/components/ui/keyboard";
import { Slider, SliderFill, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { ArrowUturnLeftIcon, BackwardIcon, ForwardIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/solid";
import { SPEEDS, STEP_MINS, type PlaybackStatus } from "../model/simulation";

/**
 * The transport for one simulation: play/pause, step, reset, speed, and a
 * scrubber across the whole plan.
 *
 * Presentational. Dragging the scrubber reports every intermediate minute
 * through `onScrub` (a local preview) and the final one through `onScrubEnd`,
 * so the screen can record a single seek rather than one per pixel.
 */
export function PlaybackControls({
    status,
    nowMins,
    makespanMins,
    speed,
    pending,
    canReset,
    onTogglePlay,
    onReset,
    onStep,
    onSpeedChange,
    onScrub,
    onScrubEnd,
}: {
    status: PlaybackStatus;
    nowMins: number;
    makespanMins: number;
    speed: number;
    /** A play, pause, reset or speed control is in flight. */
    pending: boolean;
    canReset: boolean;
    onTogglePlay: () => void;
    onReset: () => void;
    onStep: (deltaMins: number) => void;
    onSpeedChange: (speed: number) => void;
    onScrub: (mins: number) => void;
    onScrubEnd: (mins: number) => void;
}) {
    const running = status === "running";
    const playLabel = running ? "Pause" : status === "complete" ? "Replay from the start" : status === "paused" ? "Resume" : "Start";
    const remaining = Math.max(0, makespanMins - nowMins);
    const percent = makespanMins === 0 ? 0 : Math.round((nowMins / makespanMins) * 100);
    const empty = makespanMins <= 0;

    return (
        <div className="rounded-lg border bg-muted p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <div className="flex items-center gap-1.5">
                    <Button
                        intent="outline"
                        size="sq-sm"
                        aria-label={`Back ${STEP_MINS} minutes`}
                        isDisabled={empty || nowMins <= 0}
                        onPress={() => onStep(-STEP_MINS)}
                    >
                        <BackwardIcon />
                    </Button>
                    <Button
                        size="sq-md"
                        isCircle
                        intent={running ? "secondary" : "primary"}
                        aria-label={playLabel}
                        aria-keyshortcuts="Space"
                        isPending={pending}
                        isDisabled={empty}
                        onPress={onTogglePlay}
                    >
                        {running ? <PauseIcon /> : <PlayIcon />}
                    </Button>
                    <Button
                        intent="outline"
                        size="sq-sm"
                        aria-label={`Forward ${STEP_MINS} minutes`}
                        isDisabled={empty || nowMins >= makespanMins}
                        onPress={() => onStep(STEP_MINS)}
                    >
                        <ForwardIcon />
                    </Button>
                </div>

                <div className="flex min-w-0 flex-col leading-tight" aria-live="off">
                    <span className="tabular-nums">
                        <span className="font-bold text-xl tracking-tight">{formatOffset(nowMins)}</span>
                        <span className="text-muted-fg text-sm"> / {formatOffset(makespanMins)}</span>
                    </span>
                    <span className="text-muted-fg text-xs tabular-nums">
                        {status === "complete" ? "Plan finished" : `${formatDuration(remaining)} to go`}
                    </span>
                </div>

                <div className="ms-auto flex flex-wrap items-center gap-2">
                    <ToggleGroup
                        aria-label="Playback speed"
                        size="sm"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={new Set([String(speed)])}
                        isDisabled={pending}
                        onSelectionChange={(keys) => {
                            const [first] = Array.from(keys);
                            if (typeof first === "string") onSpeedChange(Number(first));
                        }}
                    >
                        {SPEEDS.map((option) => (
                            <ToggleGroupItem
                                key={option.value}
                                id={String(option.value)}
                                aria-label={`${option.label} speed: ${option.hint}`}
                                className="tabular-nums"
                            >
                                {option.label}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                    <Button intent="outline" size="sm" isDisabled={pending || !canReset} onPress={onReset}>
                        <ArrowUturnLeftIcon /> Reset
                    </Button>
                </div>
            </div>

            <Slider
                aria-label="Simulation clock"
                className="mt-4"
                minValue={0}
                maxValue={Math.max(1, makespanMins)}
                step={1}
                formatOptions={{ style: "unit", unit: "minute", unitDisplay: "long" }}
                value={Math.round(nowMins)}
                isDisabled={empty}
                onChange={(value) => onScrub(Array.isArray(value) ? value[0] : value)}
                onChangeEnd={(value) => onScrubEnd(Array.isArray(value) ? value[0] : value)}
            >
                <SliderTrack className="h-2! cursor-pointer">
                    <SliderFill />
                    <SliderThumb className="cursor-grab dragging:cursor-grabbing" />
                </SliderTrack>
            </Slider>
            <div className="mt-2 flex items-center justify-between gap-3 text-muted-fg text-xs tabular-nums">
                <span>T+0:00</span>
                <span className="hidden sm:inline">
                    Drag to scrub · <Keyboard>Space</Keyboard> plays or pauses · everyone watching sees the same clock
                </span>
                <span>{percent}% · {formatOffset(makespanMins)}</span>
            </div>
        </div>
    );
}
