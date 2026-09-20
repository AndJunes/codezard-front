import type { Answer, Interpretation, Plan, Questionnaire } from "../plan/schema"

/**
 * The PM agent, as an interface first.
 *
 * There is no PM agent yet: `agente_pm` is 103 markdown files in an Obsidian vault, with no
 * code, no endpoint and no repository. Writing the interface now and a scripted double behind
 * it means the screen can be built whole today, and the day a real one exists the swap is one
 * line in `resolve()` rather than a rewrite of everything that touches it.
 */
export interface ProjectManager {
  analyze(idea: string): Promise<Interpretation>
  /** May answer with another questionnaire: new answers can reveal new ambiguities. */
  plan(idea: string, answers: Answer[]): Promise<Plan | Questionnaire>
  /** Never mutates: returns the next version, carrying why it exists. */
  revise(plan: Plan, feedback: string): Promise<Plan>
}

export class ScriptedProjectManager implements ProjectManager {
  async analyze(idea: string): Promise<Interpretation> {
    return {
      summary:
        `Entendí que querés construir: ${idea.trim()}\n\n` +
        "Antes de proponer un plan necesito cerrar algunas decisiones que no están en tu " +
        "descripción. Prefiero preguntarlas a asumirlas.",
      questionnaire: {
        reason:
          "Estas cuatro cosas cambian la forma del proyecto, y no se deducen de lo que escribiste.",
        questions: [
          { id: "storage", text: "¿Dónde se guardan los datos?", options: ["SQLite", "PostgreSQL", "En memoria, se pierde al reiniciar"] },
          { id: "auth", text: "¿Hace falta que los usuarios inicien sesión?", options: ["Sí", "No", "Más adelante"] },
          { id: "scale", text: "¿Cuánta gente lo va a usar a la vez, más o menos?", options: ["Unas pocas personas", "Cientos", "No lo sé todavía"] },
          { id: "deadline", text: "¿Hay algo que tenga que estar sí o sí en la primera versión?" },
        ],
      },
    }
  }

  async plan(idea: string, answers: Answer[]): Promise<Plan | Questionnaire> {
    const said = (id: string) => answers.find((a) => a.questionId === id)?.value ?? ""

    // A real PM would judge this. The double uses one rule so the second round is reachable
    // in a demo: an unresolved storage decision is not something to guess at.
    if (said("storage").toLowerCase().includes("no lo sé")) {
      return {
        reason: "Sin saber dónde viven los datos no puedo proponer una estructura honesta.",
        questions: [{ id: "storage", text: "¿Los datos tienen que sobrevivir a un reinicio?", options: ["Sí", "No"] }],
      }
    }

    return {
      version: 1,
      status: "draft",
      purpose: idea.trim(),
      entities: [
        { name: "Item", description: "La entidad principal del dominio.", fields: ["id", "nombre", "creado_en"] },
      ],
      roles: [{ name: said("auth").startsWith("Sí") ? "Usuario autenticado" : "Visitante", can: ["crear", "leer", "modificar", "borrar"] }],
      flows: [{ name: "CRUD completo", steps: ["crear", "listar", "consultar", "modificar", "borrar"] }],
      constraints: [
        { kind: "compatibility", statement: `Almacenamiento: ${said("storage") || "sin definir"}` },
        { kind: "performance", statement: `Escala esperada: ${said("scale") || "sin definir"}` },
      ],
      openQuestions: [
        "No se definió qué pasa cuando dos personas modifican lo mismo a la vez.",
        "No se definió qué datos son obligatorios y cuáles opcionales.",
        said("deadline") ? `Queda por acotar: ${said("deadline")}` : "No se definió qué entra en la primera versión.",
      ],
    }
  }

  async revise(plan: Plan, feedback: string): Promise<Plan> {
    return {
      ...plan,
      version: plan.version + 1,
      revisionOf: { version: plan.version, feedback },
      // A real PM would rewrite the plan. What the double must get right is that the feedback
      // is carried, visibly, instead of quietly disappearing into a new document.
      openQuestions: [...plan.openQuestions, `Pendiente de tu corrección: ${feedback}`],
    }
  }
}

export function resolve(): ProjectManager {
  return new ScriptedProjectManager()
}
