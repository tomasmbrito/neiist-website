import { Suspense } from "react";
import ShopOverview from "@/components/shop/manage/ShopOverview";
import { getAllOrders } from "@/lib/db/repositories/shop.repository";
import { requirePermission } from "@/lib/auth";
import { sanitizeOrder } from "@/utils/shop/shopUtils";
import GlobalLoading from "@/app/loading";
import { getDictionary } from "@/i18n/dictionaries";
import { defaultLocale, isValidLocale, LocaleParams } from "@/i18n/i18n-config";

async function ShopOverviewContent({ params }: { params: LocaleParams }) {
  await requirePermission("orders:read");

  const { locale: rawLocale } = await params;
  const locale = isValidLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = getDictionary(locale);

  const orders = (await getAllOrders()).map(sanitizeOrder);

  return (
    <ShopOverview
      orders={orders}
      locale={locale}
      basePath={`/${locale}`}
      dict={dict.shop_overview}
      statusLabels={dict.orders_table.status}
      paymentLabels={dict.payments.methods}
      channelLabels={dict.shop_management.channels}
    />
  );
}

export default function ShopOverviewPage({ params }: { params: LocaleParams }) {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <ShopOverviewContent params={params} />
    </Suspense>
  );
}
