import { IsString, IsOptional } from 'class-validator';

export class CreateTextbookDto {
  @IsString()
  textbookId: string;

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  cefrLevel?: string;

  @IsString()
  @IsOptional()
  promptTemplate?: string;
}
