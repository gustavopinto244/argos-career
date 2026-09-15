import { Module } from "@nestjs/common";
import { SchedulingModule } from "./scheduling/infrastructure/scheduling.module";

/** The application is a scheduled job radar. */
@Module({
  imports: [SchedulingModule],
})
export class AppModule {}
