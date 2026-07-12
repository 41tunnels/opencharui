import { z } from 'zod'

export const personaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional()
})

export type PersonaInput = z.infer<typeof personaSchema>

export const parsePersona = (data: unknown): PersonaInput => {
  return personaSchema.parse(data)
}

export const safeParsePersona = (data: unknown) => {
  return personaSchema.safeParse(data)
}
