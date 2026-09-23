import type { ExecutionStatus, ProjectStatus } from "../agents/events"

/**
 * How a status is shown. One table, on purpose.
 *
 * UX-4 of the PRD: "shall present 'no comprobado' with the same visual weight as 'falló'".
 * The backend agent no longer runs the code it writes, so `not_executed` and `GENERATED` are
 * what production returns every time. Rendering those as a pass would be the exact lie the
 * agent was rebuilt to stop telling — and if this mapping lived inside the components, one
 * `if` somewhere would eventually say "listo" about something nobody ran.
 */

export type Tone = "pending" | "bad" | "good" | "neutral"

export type Badge = { label: string; tone: Tone; detail: string }

const EXECUTION: Record<ExecutionStatus, Badge> = {
  passed: { label: "Tests en verde", tone: "good", detail: "Se ejecutaron y pasaron. No significa que sea correcto: significa que eso que probaron, pasó." },
  failed: { label: "Falló", tone: "bad", detail: "Se ejecutó y falló." },
  no_evidence: { label: "Sin evidencia", tone: "pending", detail: "Terminó sin error y no imprimió ni un marcador. Eso no es aprobar." },
  not_executed: { label: "Pendiente de QA", tone: "pending", detail: "Se entregó el código y sus tests sin ejecutarlos. No es un aprobado ni un suspenso: nadie lo miró todavía." },
}

const PROJECT: Record<ProjectStatus, Badge> = {
  INCOMPLETE: { label: "Incompleto", tone: "bad", detail: "Faltan archivos que el plano pedía. No se entrega: un proyecto al que le falta un módulo no es una versión menor de uno completo." },
  GENERATED: { label: "Pendiente de QA", tone: "pending", detail: "Hay archivos y nada se ha llegado a ejecutar." },
  VALIDATED: { label: "Pendiente de QA", tone: "pending", detail: "Pasó las comprobaciones estáticas; no se ejecutó." },
  EXECUTED: { label: "Ejecutado sin evidencia", tone: "pending", detail: "Corrió y no dejó marcadores de qué se probó." },
  TESTED: { label: "Probado", tone: "neutral", detail: "Se ejecutaron sus tests." },
  VERIFIED: { label: "Verificado", tone: "good", detail: "Se ejecutó y sus marcadores pasaron." },
  PARTIAL: { label: "Parcial", tone: "bad", detail: "Parte pasó y parte no." },
  FAILED: { label: "Fallido", tone: "bad", detail: "No superó las comprobaciones." },
}

export const badgeForExecution = (s: ExecutionStatus): Badge => EXECUTION[s]
export const badgeForProject = (s: ProjectStatus): Badge => PROJECT[s]
