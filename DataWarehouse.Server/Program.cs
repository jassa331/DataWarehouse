using Microsoft.Data.SqlClient;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var jwtKey = builder.Configuration["Jwt:Key"]!;
var jwtIssuer = builder.Configuration["Jwt:Issuer"]!;
var jwtAudience = builder.Configuration["Jwt:Audience"]!;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey))
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();

app.UseExceptionHandler();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")!;

var api = app.MapGroup("/api").RequireAuthorization();

// GET /api/tables — returns list of user table names
api.MapGet("tables", async () =>
{
    var tables = new List<string>();
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    await using var cmd = new SqlCommand(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", conn);
    await using var reader = await cmd.ExecuteReaderAsync();
    while (await reader.ReadAsync())
        tables.Add(reader.GetString(0));
    return Results.Ok(tables);
});

// GET /api/tables/{name} — returns columns + paginated rows
api.MapGet("tables/{name}", async (string name, int page, int pageSize) =>
{
    if (pageSize <= 0) pageSize = 50;
    if (pageSize > 500) pageSize = 500;
    if (page <= 0) page = 1;
    int offset = (page - 1) * pageSize;

    // Validate table name exists (prevents SQL injection)
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();

    await using var checkCmd = new SqlCommand(
        "SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@name", conn);
    checkCmd.Parameters.AddWithValue("@name", name);
    var exists = (int)(await checkCmd.ExecuteScalarAsync())! > 0;
    if (!exists) return Results.NotFound(new { error = $"Table '{name}' not found." });

    // Total row count
    await using var countCmd = new SqlCommand($"SELECT COUNT(1) FROM [{name}]", conn);
    var totalRows = (int)(await countCmd.ExecuteScalarAsync())!;

    // Fetch page
    var quotedName = $"[{name.Replace("]", "]]")}]";
    var sql = $"SELECT * FROM {quotedName} ORDER BY (SELECT NULL) OFFSET {offset} ROWS FETCH NEXT {pageSize} ROWS ONLY";
    await using var dataCmd = new SqlCommand(sql, conn);
    await using var reader = await dataCmd.ExecuteReaderAsync();

    var columns = Enumerable.Range(0, reader.FieldCount).Select(i => reader.GetName(i)).ToList();
    var rows = new List<Dictionary<string, object?>>();
    while (await reader.ReadAsync())
    {
        var row = new Dictionary<string, object?>();
        for (int i = 0; i < reader.FieldCount; i++)
            row[columns[i]] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        rows.Add(row);
    }

    return Results.Ok(new { totalRows, page, pageSize, columns, rows });
});

// GET /api/tables/{name}/stats — basic column statistics
api.MapGet("tables/{name}/stats", async (string name) =>
{
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();

    await using var checkCmd = new SqlCommand(
        "SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@name", conn);
    checkCmd.Parameters.AddWithValue("@name", name);
    var exists = (int)(await checkCmd.ExecuteScalarAsync())! > 0;
    if (!exists) return Results.NotFound(new { error = $"Table '{name}' not found." });

    await using var cmd = new SqlCommand(
        @"SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE
          FROM INFORMATION_SCHEMA.COLUMNS c
          WHERE c.TABLE_NAME = @name
          ORDER BY c.ORDINAL_POSITION", conn);
    cmd.Parameters.AddWithValue("@name", name);
    await using var reader = await cmd.ExecuteReaderAsync();
    var cols = new List<object>();
    while (await reader.ReadAsync())
        cols.Add(new
        {
            name = reader.GetString(0),
            dataType = reader.GetString(1),
            maxLength = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2),
            nullable = reader.GetString(3) == "YES"
        });
    return Results.Ok(cols);
});

// GET /api/tables/{name}/schema — full schema: columns (PK, FK, identity, default, precision), indexes, FK refs
api.MapGet("tables/{name}/schema", async (string name) =>
{
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();

    await using var checkCmd = new SqlCommand(
        "SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@name", conn);
    checkCmd.Parameters.AddWithValue("@name", name);
    var exists = (int)(await checkCmd.ExecuteScalarAsync())! > 0;
    if (!exists) return Results.NotFound(new { error = $"Table '{name}' not found." });

    // ── Columns with full detail ──────────────────────────────────────────────
    var columnSql = @"
        SELECT
            c.ORDINAL_POSITION                              AS ordinal,
            c.COLUMN_NAME                                   AS colName,
            c.DATA_TYPE                                     AS dataType,
            c.CHARACTER_MAXIMUM_LENGTH                      AS maxLength,
            c.NUMERIC_PRECISION                             AS precision,
            c.NUMERIC_SCALE                                 AS scale,
            c.IS_NULLABLE                                   AS isNullable,
            c.COLUMN_DEFAULT                                AS colDefault,
            COLUMNPROPERTY(OBJECT_ID(@name), c.COLUMN_NAME, 'IsIdentity') AS isIdentity,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END        AS isPk,
            fk.REFERENCED_TABLE                             AS fkTable,
            fk.REFERENCED_COLUMN                            AS fkColumn
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
            SELECT ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_NAME = ku.TABLE_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @name
        ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
        LEFT JOIN (
            SELECT
                ku.COLUMN_NAME,
                ku2.TABLE_NAME  AS REFERENCED_TABLE,
                ku2.COLUMN_NAME AS REFERENCED_COLUMN
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON rc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND ku.TABLE_NAME = @name
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku2
              ON rc.UNIQUE_CONSTRAINT_NAME = ku2.CONSTRAINT_NAME
        ) fk ON fk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_NAME = @name
        ORDER BY c.ORDINAL_POSITION";

    await using var colCmd = new SqlCommand(columnSql, conn);
    colCmd.Parameters.AddWithValue("@name", name);
    await using var colReader = await colCmd.ExecuteReaderAsync();

    var columns = new List<object>();
    while (await colReader.ReadAsync())
    {
        columns.Add(new
        {
            ordinal    = colReader.GetInt32(0),
            name       = colReader.GetString(1),
            dataType   = colReader.GetString(2),
            maxLength  = colReader.IsDBNull(3)  ? (int?)null    : colReader.GetInt32(3),
            precision  = colReader.IsDBNull(4)  ? (byte?)null   : colReader.GetByte(4),
            scale      = colReader.IsDBNull(5)  ? (int?)null    : colReader.GetInt32(5),
            nullable   = colReader.GetString(6) == "YES",
            defaultVal = colReader.IsDBNull(7)  ? null          : colReader.GetString(7),
            isIdentity = colReader.GetInt32(8)  == 1,
            isPrimaryKey = colReader.GetInt32(9) == 1,
            fkTable    = colReader.IsDBNull(10) ? null          : colReader.GetString(10),
            fkColumn   = colReader.IsDBNull(11) ? null          : colReader.GetString(11),
        });
    }
    await colReader.CloseAsync();

    // ── Indexes ───────────────────────────────────────────────────────────────
    var indexSql = @"
        SELECT
            i.name                          AS indexName,
            i.type_desc                     AS indexType,
            i.is_unique                     AS isUnique,
            i.is_primary_key                AS isPk,
            STRING_AGG(c.name, ', ')
                WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c        ON ic.object_id = c.object_id  AND ic.column_id = c.column_id
        JOIN sys.tables t         ON i.object_id = t.object_id
        WHERE t.name = @name AND ic.is_included_column = 0
        GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
        ORDER BY i.is_primary_key DESC, i.name";

    await using var idxCmd = new SqlCommand(indexSql, conn);
    idxCmd.Parameters.AddWithValue("@name", name);
    await using var idxReader = await idxCmd.ExecuteReaderAsync();

    var indexes = new List<object>();
    while (await idxReader.ReadAsync())
    {
        indexes.Add(new
        {
            indexName = idxReader.IsDBNull(0) ? "(heap)" : idxReader.GetString(0),
            indexType = idxReader.GetString(1),
            isUnique  = idxReader.GetBoolean(2),
            isPk      = idxReader.GetBoolean(3),
            columns   = idxReader.IsDBNull(4) ? "" : idxReader.GetString(4),
        });
    }
    await idxReader.CloseAsync();

    // ── Incoming FK references (other tables pointing here) ───────────────────
    var incomingFkSql = @"
        SELECT
            tp.name  AS fromTable,
            cp.name  AS fromColumn,
            cr.name  AS toColumn
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        JOIN sys.tables tp  ON fkc.parent_object_id   = tp.object_id
        JOIN sys.tables tr  ON fkc.referenced_object_id = tr.object_id
        JOIN sys.columns cp ON fkc.parent_object_id   = cp.object_id AND fkc.parent_column_id   = cp.column_id
        JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
        WHERE tr.name = @name
        ORDER BY tp.name, cp.name";

    await using var fkCmd = new SqlCommand(incomingFkSql, conn);
    fkCmd.Parameters.AddWithValue("@name", name);
    await using var fkReader = await fkCmd.ExecuteReaderAsync();

    var incomingFks = new List<object>();
    while (await fkReader.ReadAsync())
    {
        incomingFks.Add(new
        {
            fromTable = fkReader.GetString(0),
            fromColumn = fkReader.GetString(1),
            toColumn = fkReader.GetString(2),
        });
    }

    await fkReader.CloseAsync();

    // ── Row count ─────────────────────────────────────────────────────────────
    var quotedName = $"[{name.Replace("]", "]]")}]";

    await using var cntCmd =
        new SqlCommand($"SELECT COUNT(1) FROM {quotedName}", conn);

    var rowCount = (int)(await cntCmd.ExecuteScalarAsync())!;

    return Results.Ok(new { tableName = name, rowCount, columns, indexes, incomingFks });
});

// GET /api/auditlogs — paginated audit log viewer with optional filters
api.MapGet("auditlogs", async (int page, int pageSize, string? action, string? tableName) =>
{
    if (pageSize <= 0) pageSize = 30;
    if (pageSize > 200) pageSize = 200;
    if (page <= 0) page = 1;
    int offset = (page - 1) * pageSize;

    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();

    var where = new List<string>();
    if (!string.IsNullOrWhiteSpace(action))    where.Add("Action = @action");
    if (!string.IsNullOrWhiteSpace(tableName)) where.Add("TableName = @tableName");
    var whereClause = where.Count > 0 ? "WHERE " + string.Join(" AND ", where) : "";

    await using var cntCmd = new SqlCommand($"SELECT COUNT(1) FROM [dbo].[AuditLogs] {whereClause}", conn);
    if (!string.IsNullOrWhiteSpace(action))    cntCmd.Parameters.AddWithValue("@action", action);
    if (!string.IsNullOrWhiteSpace(tableName)) cntCmd.Parameters.AddWithValue("@tableName", tableName);
    var totalRows = (int)(await cntCmd.ExecuteScalarAsync())!;

    var sql = $@"
        SELECT Id, TableName, Action, RecordId, OldValues, NewValues, ChangedBy, ChangedAt
        FROM [dbo].[AuditLogs]
        {whereClause}
        ORDER BY ChangedAt DESC, Id DESC
        OFFSET {offset} ROWS FETCH NEXT {pageSize} ROWS ONLY";

    await using var cmd = new SqlCommand(sql, conn);
    if (!string.IsNullOrWhiteSpace(action))    cmd.Parameters.AddWithValue("@action", action);
    if (!string.IsNullOrWhiteSpace(tableName)) cmd.Parameters.AddWithValue("@tableName", tableName);

    await using var reader = await cmd.ExecuteReaderAsync();
    var logs = new List<object>();
    while (await reader.ReadAsync())
    {
        logs.Add(new
        {
            id         = reader.GetInt32(0),
            tableName  = reader.GetString(1),
            action     = reader.GetString(2),
            recordId   = reader.IsDBNull(3) ? null : reader.GetValue(3),
            oldValues  = reader.IsDBNull(4) ? null : reader.GetString(4),
            newValues  = reader.IsDBNull(5) ? null : reader.GetString(5),
            changedBy  = reader.IsDBNull(6) ? null : reader.GetString(6),
            changedAt  = reader.GetDateTime(7).ToString("o"),
        });
    }

    return Results.Ok(new { totalRows, page, pageSize, logs });
});

app.MapDefaultEndpoints();

// ── Warehouse Analytics API ──────────────────────────────────────────────────
var warehouse = app.MapGroup("/api/warehouse").RequireAuthorization();

// GET /api/warehouse/overview — summary stats
warehouse.MapGet("overview", async () =>
{
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = @"
        SELECT
            (SELECT COUNT(*) FROM Orders) AS totalOrders,
            (SELECT ISNULL(SUM(TotalAmount),0) FROM Orders WHERE Status NOT IN ('Cancelled')) AS totalRevenue,
            (SELECT COUNT(*) FROM Products WHERE IsActive=1) AS activeProducts,
            (SELECT COUNT(*) FROM Services WHERE IsActive=1) AS activeServices,
            (SELECT COUNT(DISTINCT u.Id) FROM AspNetUsers u JOIN AspNetUserRoles ur ON u.Id=ur.UserId JOIN AspNetRoles r ON ur.RoleId=r.Id WHERE r.Name='Worker') AS totalWorkers,
            (SELECT COUNT(DISTINCT CustomerId) FROM Orders) AS totalCustomers,
            (SELECT COUNT(*) FROM Orders WHERE CAST(CreatedAt AS DATE)=CAST(GETDATE() AS DATE)) AS ordersToday,
            (SELECT ISNULL(SUM(TotalAmount),0) FROM Orders WHERE CAST(CreatedAt AS DATE)=CAST(GETDATE() AS DATE) AND Status NOT IN ('Cancelled')) AS revenueToday";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    await r.ReadAsync();
    return Results.Ok(new
    {
        totalOrders = r.GetInt32(0),
        totalRevenue = r.GetDecimal(1),
        activeProducts = r.GetInt32(2),
        activeServices = r.GetInt32(3),
        totalWorkers = r.GetInt32(4),
        totalCustomers = r.GetInt32(5),
        ordersToday = r.GetInt32(6),
        revenueToday = r.GetDecimal(7)
    });
});

// GET /api/warehouse/top-products — top selling products
warehouse.MapGet("top-products", async (int? limit) =>
{
    var top = limit ?? 10;
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = $@"
        SELECT TOP({top})
            p.Id, p.Name, p.Price, p.ImageUrl, p.Rating, p.TotalReviews, p.Stock,
            c.Name AS CategoryName,
            ISNULL(SUM(oi.Quantity),0) AS totalSold,
            ISNULL(SUM(oi.TotalPrice),0) AS totalRevenue
        FROM Products p
        LEFT JOIN Categories c ON p.CategoryId=c.Id
        LEFT JOIN OrderItems oi ON oi.ProductId=p.Id
        LEFT JOIN Orders o ON oi.OrderId=o.Id AND o.Status NOT IN ('Cancelled')
        WHERE p.IsActive=1
        GROUP BY p.Id, p.Name, p.Price, p.ImageUrl, p.Rating, p.TotalReviews, p.Stock, c.Name
        ORDER BY totalSold DESC, totalRevenue DESC";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    var list = new List<object>();
    while (await r.ReadAsync())
        list.Add(new
        {
            id = r.GetInt32(0), name = r.GetString(1), price = r.GetDecimal(2),
            imageUrl = r.IsDBNull(3) ? null : r.GetString(3),
            rating = r.IsDBNull(4) ? 0.0 : r.GetDouble(4), totalReviews = r.GetInt32(5),
            stock = r.GetInt32(6), category = r.IsDBNull(7) ? null : r.GetString(7),
            totalSold = r.GetInt32(8), totalRevenue = r.GetDecimal(9)
        });
    return Results.Ok(list);
});

// GET /api/warehouse/top-services — most booked services
warehouse.MapGet("top-services", async (int? limit) =>
{
    var top = limit ?? 10;
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = $@"
        SELECT TOP({top})
            s.Id, s.Title, s.Price, s.PriceType, s.ImageUrl, s.Rating, s.TotalReviews,
            c.Name AS CategoryName,
            u.FullName AS WorkerName,
            COUNT(o.Id) AS totalBookings,
            ISNULL(SUM(o.TotalAmount),0) AS totalRevenue
        FROM Services s
        LEFT JOIN Categories c ON s.CategoryId=c.Id
        LEFT JOIN AspNetUsers u ON s.WorkerId=u.Id
        LEFT JOIN Orders o ON o.ServiceId=s.Id AND o.Status NOT IN ('Cancelled')
        WHERE s.IsActive=1
        GROUP BY s.Id, s.Title, s.Price, s.PriceType, s.ImageUrl, s.Rating, s.TotalReviews, c.Name, u.FullName
        ORDER BY totalBookings DESC, totalRevenue DESC";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    var list = new List<object>();
    while (await r.ReadAsync())
        list.Add(new
        {
            id = r.GetInt32(0), title = r.GetString(1), price = r.GetDecimal(2),
            priceType = r.IsDBNull(3) ? null : r.GetString(3),
            imageUrl = r.IsDBNull(4) ? null : r.GetString(4),
            rating = r.IsDBNull(5) ? 0.0 : r.GetDouble(5), totalReviews = r.GetInt32(6),
            category = r.IsDBNull(7) ? null : r.GetString(7),
            workerName = r.IsDBNull(8) ? null : r.GetString(8),
            totalBookings = r.GetInt32(9), totalRevenue = r.GetDecimal(10)
        });
    return Results.Ok(list);
});

// GET /api/warehouse/top-workers — highest rated workers
warehouse.MapGet("top-workers", async (int? limit) =>
{
    var top = limit ?? 10;
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = $@"
        SELECT TOP({top})
            u.Id, u.FullName, u.ProfileImage, u.Rating, u.TotalReviews, u.Skills, u.HourlyRate,
            COUNT(DISTINCT o.Id) AS totalJobs,
            ISNULL(SUM(o.TotalAmount),0) AS totalEarnings
        FROM AspNetUsers u
        JOIN AspNetUserRoles ur ON u.Id=ur.UserId
        JOIN AspNetRoles rl ON ur.RoleId=rl.Id
        LEFT JOIN Orders o ON o.WorkerId=u.Id AND o.Status NOT IN ('Cancelled')
        WHERE rl.Name='Worker' AND u.IsActive=1
        GROUP BY u.Id, u.FullName, u.ProfileImage, u.Rating, u.TotalReviews, u.Skills, u.HourlyRate
        ORDER BY u.Rating DESC, totalJobs DESC";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    var list = new List<object>();
    while (await r.ReadAsync())
        list.Add(new
        {
            id = r.GetString(0), fullName = r.IsDBNull(1) ? null : r.GetString(1),
            profileImage = r.IsDBNull(2) ? null : r.GetString(2),
            rating = r.IsDBNull(3) ? 0.0 : r.GetDouble(3), totalReviews = r.GetInt32(4),
            skills = r.IsDBNull(5) ? null : r.GetString(5),
            hourlyRate = r.IsDBNull(6) ? (decimal?)null : r.GetDecimal(6),
            totalJobs = r.GetInt32(7), totalEarnings = r.GetDecimal(8)
        });
    return Results.Ok(list);
});

// GET /api/warehouse/revenue-by-category — revenue breakdown
warehouse.MapGet("revenue-by-category", async () =>
{
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = @"
        SELECT c.Name, COUNT(DISTINCT o.Id) AS orderCount, ISNULL(SUM(oi.TotalPrice),0) AS revenue
        FROM Categories c
        LEFT JOIN Products p ON p.CategoryId=c.Id
        LEFT JOIN OrderItems oi ON oi.ProductId=p.Id
        LEFT JOIN Orders o ON oi.OrderId=o.Id AND o.Status NOT IN ('Cancelled')
        WHERE c.IsActive=1
        GROUP BY c.Id, c.Name
        ORDER BY revenue DESC";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    var list = new List<object>();
    while (await r.ReadAsync())
        list.Add(new
        {
            category = r.GetString(0), orderCount = r.GetInt32(1), revenue = r.GetDecimal(2)
        });
    return Results.Ok(list);
});

// GET /api/warehouse/recent-orders — last 20 orders
warehouse.MapGet("recent-orders", async (int? limit) =>
{
    var top = limit ?? 20;
    await using var conn = new SqlConnection(connectionString);
    await conn.OpenAsync();
    var sql = $@"
        SELECT TOP({top})
            o.Id, o.OrderNumber, o.Status, o.TotalAmount, o.OrderType, o.PaymentStatus,
            o.CreatedAt, u.FullName AS CustomerName
        FROM Orders o
        LEFT JOIN AspNetUsers u ON o.CustomerId=u.Id
        ORDER BY o.CreatedAt DESC";
    await using var cmd = new SqlCommand(sql, conn);
    await using var r = await cmd.ExecuteReaderAsync();
    var list = new List<object>();
    while (await r.ReadAsync())
        list.Add(new
        {
            id = r.GetInt32(0), orderNumber = r.IsDBNull(1) ? null : r.GetString(1),
            status = r.IsDBNull(2) ? null : r.GetString(2),
            totalAmount = r.GetDecimal(3), orderType = r.IsDBNull(4) ? null : r.GetString(4),
            paymentStatus = r.IsDBNull(5) ? null : r.GetString(5),
            createdAt = r.GetDateTime(6).ToString("o"),
            customerName = r.IsDBNull(7) ? null : r.GetString(7)
        });
    return Results.Ok(list);
});

app.UseFileServer();
app.Run();
