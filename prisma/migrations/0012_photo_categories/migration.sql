-- Check-in photos: front, rear, left and right of the vehicle, and a category for photos of parts. (Values are added on their own so
-- they are committed before anything uses them.)
ALTER TYPE "photo_category" ADD VALUE IF NOT EXISTS 'CHECK_IN_FRONT';
ALTER TYPE "photo_category" ADD VALUE IF NOT EXISTS 'CHECK_IN_REAR';
ALTER TYPE "photo_category" ADD VALUE IF NOT EXISTS 'CHECK_IN_LEFT';
ALTER TYPE "photo_category" ADD VALUE IF NOT EXISTS 'CHECK_IN_RIGHT';
ALTER TYPE "photo_category" ADD VALUE IF NOT EXISTS 'PARTS';
