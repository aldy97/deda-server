import { IsString, IsOptional } from 'class-validator';

export class UpdateTextbookDto {
  @IsString()
  @IsOptional()
  name?: string;

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
