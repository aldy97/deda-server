-- CreateTable
CREATE TABLE "conversation_mode_categories" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_mode_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_modes" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "configSchema" JSONB,
    "promptTemplate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_modes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_mode_categories_key_key" ON "conversation_mode_categories"("key");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_modes_categoryId_key_key" ON "conversation_modes"("categoryId", "key");

-- AddForeignKey
ALTER TABLE "conversation_modes" ADD CONSTRAINT "conversation_modes_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "conversation_mode_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
