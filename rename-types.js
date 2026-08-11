const fs = require("fs");
const path = require("path");

const typesToRename = {
  dbUser: "DbUser",
  dbRole: "DbRole",
  dbMembership: "DbMembership",
  dbDiscountCode: "DbDiscountCode",
  dbCategory: "DbCategory",
  dbProduct: "DbProduct",
  dbProductVariant: "DbProductVariant",
  dbOrder: "DbOrder",
  dbOrderItem: "DbOrderItem",
  dbEvent: "DbEvent",
  mapdbUserToUser: "mapDbUserToUser",
  mapdbMembershipToMembership: "mapDbMembershipToMembership",
  mapdbDiscountCodeToDiscountCode: "mapDbDiscountCodeToDiscountCode",
  mapdbCategoryToCategory: "mapDbCategoryToCategory",
  mapdbProductToProduct: "mapDbProductToProduct",
  mapdbOrderToOrder: "mapDbOrderToOrder",
};

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach((f) => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir("src", (filePath) => {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    let content = fs.readFileSync(filePath, "utf8");
    let modified = false;

    for (const [oldName, newName] of Object.entries(typesToRename)) {
      const regex = new RegExp(`\\b${oldName}\\b`, "g");
      if (regex.test(content)) {
        content = content.replace(regex, newName);
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, content, "utf8");
      console.log(`Modified: ${filePath}`);
    }
  }
});
