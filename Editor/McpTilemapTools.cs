#if UNITY_EDITOR
using System;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace UniMCP4CC.Editor
{
  internal static class McpTilemapTools
  {
    [Serializable]
    private sealed class ResultPayload
    {
      public string status;
      public string message;
      public string tilemapPath;
      public string tileAssetPath;
      public string tileName;
      public int x;
      public int y;
      public int z;
      public int candidateCount;
      public string[] candidatePaths;
    }

    public static string SetTileBase64(string tilemapPath, string x, string y, string z, string tileAssetPath)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          tilemapPath = tilemapPath,
          tileAssetPath = tileAssetPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(tilemapPath))
        {
          return EncodeResult("error", "tilemapPath is required");
        }

        if (string.IsNullOrWhiteSpace(tileAssetPath))
        {
          return EncodeResult("error", "tileAssetPath is required");
        }

        if (!TryParseInt(x, out var parsedX) || !TryParseInt(y, out var parsedY) || !TryParseOptionalInt(z, out var parsedZ))
        {
          return EncodeResult("error", "x and y must be valid integers (z is optional)");
        }

        if (!TryResolveTilemapTypes(out var tilemapType, out var tileBaseType, out var typeError))
        {
          return EncodeResult("error", typeError);
        }

        if (!TryResolveTilemapComponent(tilemapPath.Trim(), tilemapType, out var tilemapComponent, out var errorMessage, out var candidatePaths))
        {
          return EncodeResult(
            "error",
            errorMessage,
            payload =>
            {
              payload.candidatePaths = candidatePaths;
              payload.candidateCount = candidatePaths != null ? candidatePaths.Length : 0;
            }
          );
        }

        var tile = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(tileAssetPath.Trim());
        if (tile == null)
        {
          return EncodeResult("error", $"Tile asset not found: {tileAssetPath}");
        }

        if (!tileBaseType.IsInstanceOfType(tile))
        {
          return EncodeResult("error", $"Asset is not a TileBase: {tileAssetPath}");
        }

        var setTileMethod = FindSetTileMethod(tilemapType, tileBaseType);
        if (setTileMethod == null)
        {
          return EncodeResult("error", "Tilemap.SetTile method not found");
        }

        setTileMethod.Invoke(tilemapComponent, new object[] { new Vector3Int(parsedX, parsedY, parsedZ), tile });
        EditorUtility.SetDirty(tilemapComponent);

        return EncodeResult(
          "success",
          "Tile set",
          payload =>
          {
            payload.tilemapPath = tilemapPath.Trim();
            payload.tileAssetPath = tileAssetPath.Trim();
            payload.tileName = tile.name;
            payload.x = parsedX;
            payload.y = parsedY;
            payload.z = parsedZ;
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult("error", exception.Message);
      }
    }

    public static string ClearTileBase64(string tilemapPath, string x, string y, string z)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          tilemapPath = tilemapPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(tilemapPath))
        {
          return EncodeResult("error", "tilemapPath is required");
        }

        if (!TryParseInt(x, out var parsedX) || !TryParseInt(y, out var parsedY) || !TryParseOptionalInt(z, out var parsedZ))
        {
          return EncodeResult("error", "x and y must be valid integers (z is optional)");
        }

        if (!TryResolveTilemapTypes(out var tilemapType, out var tileBaseType, out var typeError))
        {
          return EncodeResult("error", typeError);
        }

        if (!TryResolveTilemapComponent(tilemapPath.Trim(), tilemapType, out var tilemapComponent, out var errorMessage, out var candidatePaths))
        {
          return EncodeResult(
            "error",
            errorMessage,
            payload =>
            {
              payload.candidatePaths = candidatePaths;
              payload.candidateCount = candidatePaths != null ? candidatePaths.Length : 0;
            }
          );
        }

        var setTileMethod = FindSetTileMethod(tilemapType, tileBaseType);
        if (setTileMethod == null)
        {
          return EncodeResult("error", "Tilemap.SetTile method not found");
        }

        setTileMethod.Invoke(tilemapComponent, new object[] { new Vector3Int(parsedX, parsedY, parsedZ), null });
        EditorUtility.SetDirty(tilemapComponent);

        return EncodeResult(
          "success",
          "Tile cleared",
          payload =>
          {
            payload.tilemapPath = tilemapPath.Trim();
            payload.x = parsedX;
            payload.y = parsedY;
            payload.z = parsedZ;
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult("error", exception.Message);
      }
    }

    private static bool TryResolveTilemapTypes(out Type tilemapType, out Type tileBaseType, out string errorMessage)
    {
      tilemapType = FindType("UnityEngine.Tilemaps.Tilemap");
      tileBaseType = FindType("UnityEngine.Tilemaps.TileBase");
      errorMessage = null;

      if (tilemapType == null || tileBaseType == null)
      {
        errorMessage = "Tilemap types are not available. Ensure the 2D Tilemap module is installed.";
        return false;
      }

      return true;
    }

    private static bool TryResolveTilemapComponent(
      string tilemapPath,
      Type tilemapType,
      out Component tilemapComponent,
      out string errorMessage,
      out string[] candidatePaths
    )
    {
      tilemapComponent = null;
      errorMessage = null;
      candidatePaths = null;

      var matches = McpEditorSceneQuery.FindSceneGameObjectsByQuery(tilemapPath);
      if (matches.Count == 0)
      {
        errorMessage = $"GameObject not found: {tilemapPath}";
        return false;
      }

      if (matches.Count > 1)
      {
        candidatePaths = McpEditorSceneQuery.BuildCandidatePaths(matches, maxCandidates: 10);
        var messageBuilder = new StringBuilder();
        messageBuilder.Append($"GameObject is ambiguous: {tilemapPath}");
        messageBuilder.Append("\nCandidates:");
        for (var index = 0; index < candidatePaths.Length; index++)
        {
          messageBuilder.Append("\n- ");
          messageBuilder.Append(candidatePaths[index]);
        }
        messageBuilder.Append("\nSpecify a full hierarchy path (e.g. \"Root/Child\").");
        errorMessage = messageBuilder.ToString();
        return false;
      }

      var gameObject = matches[0];
      if (gameObject == null)
      {
        errorMessage = $"GameObject not found: {tilemapPath}";
        return false;
      }

      tilemapComponent = gameObject.GetComponent(tilemapType);
      if (tilemapComponent == null)
      {
        errorMessage = $"Tilemap component not found: {tilemapPath}";
        return false;
      }

      return true;
    }

    private static Type FindType(string fullName)
    {
      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        try
        {
          var candidate = assembly.GetType(fullName);
          if (candidate != null)
          {
            return candidate;
          }
        }
        catch
        {
          // ignore and continue
        }
      }

      return null;
    }

    private static MethodInfo FindSetTileMethod(Type tilemapType, Type tileBaseType)
    {
      foreach (var method in tilemapType.GetMethods(BindingFlags.Instance | BindingFlags.Public))
      {
        if (!string.Equals(method.Name, "SetTile", StringComparison.Ordinal))
        {
          continue;
        }

        var parameters = method.GetParameters();
        if (parameters.Length != 2)
        {
          continue;
        }

        if (parameters[0].ParameterType != typeof(Vector3Int))
        {
          continue;
        }

        if (!parameters[1].ParameterType.IsAssignableFrom(tileBaseType))
        {
          continue;
        }

        return method;
      }

      return null;
    }

    private static bool TryParseInt(string value, out int parsed)
    {
      parsed = 0;
      if (string.IsNullOrWhiteSpace(value))
      {
        return false;
      }

      return int.TryParse(value.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed);
    }

    private static bool TryParseOptionalInt(string value, out int parsed)
    {
      if (string.IsNullOrWhiteSpace(value))
      {
        parsed = 0;
        return true;
      }

      return TryParseInt(value, out parsed);
    }

    private static string Encode(ResultPayload payload)
    {
      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
