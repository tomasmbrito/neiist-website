#!/bin/bash
find src -type f -name "*.ts" -o -name "*.tsx" | while read -r file; do
  sed -i '' -e 's/\bdbUser\b/DbUser/g' "$file"
  sed -i '' -e 's/\bdbRole\b/DbRole/g' "$file"
  sed -i '' -e 's/\bdbMembership\b/DbMembership/g' "$file"
  sed -i '' -e 's/\bdbDiscountCode\b/DbDiscountCode/g' "$file"
  sed -i '' -e 's/\bdbCategory\b/DbCategory/g' "$file"
  sed -i '' -e 's/\bdbProduct\b/DbProduct/g' "$file"
  sed -i '' -e 's/\bdbProductVariant\b/DbProductVariant/g' "$file"
  sed -i '' -e 's/\bdbOrder\b/DbOrder/g' "$file"
  sed -i '' -e 's/\bdbOrderItem\b/DbOrderItem/g' "$file"
  sed -i '' -e 's/\bdbEvent\b/DbEvent/g' "$file"
  sed -i '' -e 's/\bmapdb/mapDb/g' "$file"
done
