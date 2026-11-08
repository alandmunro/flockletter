export function CompanyUsage({
  companies,
  brands,
  limits,
}: {
  companies: number;
  brands: number;
  limits: { companies: number; brands: number };
}) {
  const exceeded = companies > limits.companies || brands > limits.brands;

  return (
    <>
      <dl className="intake-metrics" aria-label="Company and brand usage">
        <dt>Companies</dt>
        <dd>
          {companies} of {limits.companies}
        </dd>

        <dt>Brands</dt>
        <dd>
          {brands} of {limits.brands}
        </dd>
      </dl>

      {exceeded ? (
        <p role="status">
          Your plan limit has been exceeded. Your existing companies and brands stay available.
        </p>
      ) : null}
    </>
  );
}
