import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class ImportTextbookFromFileDto {
  @IsString()
  filePath: string;

  @IsString()
  textbookId: string;

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

  @IsBoolean()
  @IsOptional()
  singleUnit?: boolean;

  @IsBoolean()
  @IsOptional()
  unitMarkers?: boolean;

  @IsString()
  @IsOptional()
  singleUnitName?: string;

  @IsString()
  @IsOptional()
  singleUnitId?: string;
}
