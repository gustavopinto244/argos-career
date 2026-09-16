import { z } from "zod";
import { CollectionSchema } from "../../prefilter/domain/criteria";

const ScheduleSchema = z.strictObject({
  collection: z.strictObject({
    intervalHours: z
      .number()
      .int()
      .min(1)
      .max(24)
      .refine((hours) => 24 % hours === 0, {
        message: "intervalHours must divide 24 evenly",
      })
      .default(4),
  }),
  delivery: z.strictObject({
    times: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .min(1)
      .transform((times) => [...new Set(times)].sort()),
    timezone: z.string().min(1).default("America/Sao_Paulo"),
  }),
});

export const JobRadarConfigSchema = z.strictObject({
  search: z.strictObject({
    label: z.string().min(1).default("Busca de vagas"),
    location: z.string().min(1).default("Localização ampla"),
  }),
  collection: CollectionSchema,
  schedule: ScheduleSchema,
  delivery: z
    .strictObject({
      onsiteCity: z.string().min(1).default("Joinville"),
      titleTerms: z
        .array(z.string().min(1))
        .min(1)
        .default([
          "analista",
          "auxiliar",
          "assistente",
          "negociador",
          "atendente",
          "recepcionista",
          "operador",
          "vendedor",
        ]),
    })
    .default({
      onsiteCity: "Joinville",
      titleTerms: [
        "analista",
        "auxiliar",
        "assistente",
        "negociador",
        "atendente",
        "recepcionista",
        "operador",
        "vendedor",
      ],
    }),
});

export type JobRadarConfig = z.infer<typeof JobRadarConfigSchema>;
