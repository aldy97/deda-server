import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';

export class UpdateUnitDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  cefrLevel?: string;

  @IsNumber()
  @IsOptional()
  difficulty?: number;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsString()
  @IsOptional()
  content?: string;
}
