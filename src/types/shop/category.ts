export interface Category {
  id: number;
  name: string;
}

export interface DbCategory {
  category_id: number;
  category_name: string;
}

export function mapDbCategoryToCategory(row: DbCategory): Category {
  return {
    id: row.category_id,
    name: row.category_name,
  };
}
