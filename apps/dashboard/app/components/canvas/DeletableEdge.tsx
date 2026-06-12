"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { useEdgeFanOffset } from "@/app/components/canvas/useEdgeFanOffset";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const HOVER_COLOR = "rgb(239, 68, 68, 0.9)";
const ARROW_ID_PREFIX = "deletable-arrow";

/**
 * Custom edge with a hover-to-delete trash icon. Reads its endpoints to style by kind (A):
 * an agent→sandbox edge is labelled "default".
 */
export function DeletableEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);

  // Endpoint types as a single primitive so the selector stays referentially stable.
  const endpointTypes = useStore(
    (s) =>
      `${s.nodeLookup.get(source)?.type ?? ""}>${s.nodeLookup.get(target)?.type ?? ""}`,
  );
  const [sourceType, targetType] = endpointTypes.split(">");
  const isDefaultSandbox =
    (sourceType === "agent" && targetType === "sandbox") ||
    (sourceType === "sandbox" && targetType === "agent");

  // Fan parallel edges apart so their vertical trunks don't stack (flow is vertical → offset X).
  const [sourceFan, targetFan] = useEdgeFanOffset(
    id,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    "default",
  );

  // Rigid orthogonal routing to match the workspace↔sandbox mount edge styling.
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX + sourceFan,
    sourceY: sourceY,
    targetX: targetX + targetFan,
    targetY: targetY,
    sourcePosition: sourcePosition,
    targetPosition: targetPosition,
    borderRadius: 16,
  });

  const edgeStyle = hovered
    ? { ...style, stroke: HOVER_COLOR, strokeWidth: 2 }
    : style;
  const arrowId = `${ARROW_ID_PREFIX}-${id}`;

  return (
    <>
      {/* The default arrowhead is a shared theme-colored marker def, so it can't follow the
          per-edge hover color — swap in this red copy of the same shape while hovered. */}
      <defs>
        <marker
          id={arrowId}
          viewBox="-10 -10 20 20"
          refX="0"
          refY="0"
          markerWidth="18"
          markerHeight="18"
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
        >
          <polyline
            points="-5,-4 0,0 -5,4 -5,-4"
            fill={HOVER_COLOR}
            stroke={HOVER_COLOR}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        style={edgeStyle}
        markerEnd={hovered ? `url(#${arrowId})` : markerEnd}
      />
      <EdgeLabelRenderer>
        {/* Subtle "default" marker at the midpoint; hidden on hover so the delete button takes over */}
        {isDefaultSandbox && !hovered && (
          <div
            className="nodrag nopan pointer-events-none absolute text-[8px] font-medium uppercase tracking-[0.08em] text-muted-foreground/50"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            default
          </div>
        )}

        <EdgeDeleteButton
          edgeId={id}
          labelX={labelX}
          labelY={labelY}
          onHoverChange={setHovered}
        />
      </EdgeLabelRenderer>
    </>
  );
}
