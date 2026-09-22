import { IsString, IsOptional, IsNumber, IsInt } from 'class-validator';

export class CreateUnitDto {
  @IsString()
  unitId: string;

  @IsString()
  name: string;

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
  content: string;
}
