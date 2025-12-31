#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace UniMCP4CC.Editor
{
  internal static class McpAssetImport
  {
    [Serializable]
    private sealed class ResultPayload
    {
      public string status;
      public string message;
      public string assetPath;
      public string textureType;
      public string gameObjectPath;
      public string componentType;
      public string fieldName;
      public string referenceName;
      public string spriteName;
      public int spriteCount;
      public string[] spriteNames;
    }

    public static string SetTextureTypeBase64(string assetPath, string textureType, string reimport)
    {
      try
      {
        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = "assetPath is required",
            assetPath = assetPath,
          });
        }

        var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
        if (importer == null)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"No TextureImporter found at path: {assetPath}",
            assetPath = assetPath,
          });
        }

        if (!TryParseTextureImporterType(textureType, out var parsedType))
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"Unsupported textureType: {textureType}",
            assetPath = assetPath,
            textureType = textureType,
          });
        }

        importer.textureType = parsedType;
        if (parsedType == TextureImporterType.Sprite && importer.spriteImportMode == SpriteImportMode.None)
        {
          importer.spriteImportMode = SpriteImportMode.Single;
        }

        if (ParseBoolean(reimport, fallback: true))
        {
          importer.SaveAndReimport();
        }

        return Encode(new ResultPayload
        {
          status = "success",
          message = "Texture importer updated",
          assetPath = assetPath,
          textureType = importer.textureType.ToString(),
        });
      }
      catch (Exception exception)
      {
        return Encode(new ResultPayload
        {
          status = "error",
          message = exception.Message,
          assetPath = assetPath,
          textureType = textureType,
        });
      }
    }

    public static string ListSpritesBase64(string assetPath)
    {
      try
      {
        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = "assetPath is required",
            assetPath = assetPath,
          });
        }

        var sprites = CollectSpritesAtPath(assetPath);
        var names = new string[sprites.Count];
        for (var index = 0; index < sprites.Count; index++)
        {
          names[index] = sprites[index] != null ? sprites[index].name : string.Empty;
        }

        return Encode(new ResultPayload
        {
          status = sprites.Count > 0 ? "success" : "error",
          message = sprites.Count > 0 ? "Sprites found" : $"No sprites found at path: {assetPath}",
          assetPath = assetPath,
          spriteCount = sprites.Count,
          spriteNames = names,
        });
      }
      catch (Exception exception)
      {
        return Encode(new ResultPayload
        {
          status = "error",
          message = exception.Message,
          assetPath = assetPath,
        });
      }
    }

    public static string SetSpriteReferenceBase64(
      string gameObjectPath,
      string componentType,
      string fieldName,
      string assetPath,
      string spriteName
    )
    {
      try
      {
        if (string.IsNullOrWhiteSpace(gameObjectPath) || string.IsNullOrWhiteSpace(componentType) || string.IsNullOrWhiteSpace(fieldName))
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = "gameObjectPath, componentType, and fieldName are required",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        var gameObject = GameObject.Find(gameObjectPath);
        if (gameObject == null)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"GameObject not found: {gameObjectPath}",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        var resolvedComponentType = ResolveType(componentType);
        if (resolvedComponentType == null)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"Component type not found: {componentType}",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        var component = gameObject.GetComponent(resolvedComponentType);
        if (component == null)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"Component not found: {componentType} on {gameObjectPath}",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = "assetPath is required",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        var sprites = CollectSpritesAtPath(assetPath);
        if (sprites.Count == 0)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"Sprite not found at path: {assetPath}",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        Sprite sprite = null;
        var spriteNameTrimmed = string.IsNullOrWhiteSpace(spriteName) ? string.Empty : spriteName.Trim();
        if (!string.IsNullOrEmpty(spriteNameTrimmed))
        {
          foreach (var candidate in sprites)
          {
            if (candidate != null && string.Equals(candidate.name, spriteNameTrimmed, StringComparison.Ordinal))
            {
              sprite = candidate;
              break;
            }
          }

          if (sprite == null)
          {
            foreach (var candidate in sprites)
            {
              if (candidate != null && string.Equals(candidate.name, spriteNameTrimmed, StringComparison.OrdinalIgnoreCase))
              {
                sprite = candidate;
                break;
              }
            }
          }
        }
        else if (sprites.Count == 1)
        {
          sprite = sprites[0];
        }

        if (sprite == null)
        {
          var names = new string[sprites.Count];
          for (var index = 0; index < sprites.Count; index++)
          {
            names[index] = sprites[index] != null ? sprites[index].name : string.Empty;
          }

          return Encode(new ResultPayload
          {
            status = "error",
            message =
              sprites.Count <= 1
                ? $"Sprite not found at path: {assetPath}"
                : $"Multiple sprites found at path: {assetPath}. Specify spriteName.",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
            spriteName = spriteNameTrimmed,
            spriteCount = sprites.Count,
            spriteNames = names,
          });
        }

        if (component is SpriteRenderer spriteRenderer && string.Equals(fieldName.Trim(), "sprite", StringComparison.OrdinalIgnoreCase))
        {
          spriteRenderer.sprite = sprite;
          EditorUtility.SetDirty(spriteRenderer);
          return Encode(new ResultPayload
          {
            status = "success",
            message = "SpriteRenderer.sprite updated",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
            referenceName = sprite.name,
            spriteName = sprite.name,
          });
        }

        var serializedObject = new SerializedObject(component);
        var property = serializedObject.FindProperty(fieldName);
        if (property == null)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"SerializedProperty not found: {fieldName}",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        if (property.propertyType != SerializedPropertyType.ObjectReference)
        {
          return Encode(new ResultPayload
          {
            status = "error",
            message = $"Property is not an ObjectReference: {fieldName} ({property.propertyType})",
            gameObjectPath = gameObjectPath,
            componentType = componentType,
            fieldName = fieldName,
            assetPath = assetPath,
          });
        }

        property.objectReferenceValue = sprite;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
        EditorUtility.SetDirty(component);

        return Encode(new ResultPayload
        {
          status = "success",
          message = "Sprite reference updated",
          gameObjectPath = gameObjectPath,
          componentType = componentType,
          fieldName = fieldName,
          assetPath = assetPath,
          referenceName = sprite.name,
          spriteName = sprite.name,
        });
      }
      catch (Exception exception)
      {
        return Encode(new ResultPayload
        {
          status = "error",
          message = exception.Message,
          gameObjectPath = gameObjectPath,
          componentType = componentType,
          fieldName = fieldName,
          assetPath = assetPath,
          spriteName = spriteName,
        });
      }
    }

    private static List<Sprite> CollectSpritesAtPath(string assetPath)
    {
      var sprites = new List<Sprite>();
      if (string.IsNullOrWhiteSpace(assetPath))
      {
        return sprites;
      }

      var seen = new HashSet<int>();

      void AddSprite(Sprite sprite)
      {
        if (sprite == null)
        {
          return;
        }

        var id = sprite.GetInstanceID();
        if (!seen.Add(id))
        {
          return;
        }

        sprites.Add(sprite);
      }

      AddSprite(AssetDatabase.LoadAssetAtPath<Sprite>(assetPath));

      foreach (var asset in AssetDatabase.LoadAllAssetsAtPath(assetPath))
      {
        if (asset is Sprite sprite)
        {
          AddSprite(sprite);
        }
      }

      foreach (var asset in AssetDatabase.LoadAllAssetRepresentationsAtPath(assetPath))
      {
        if (asset is Sprite sprite)
        {
          AddSprite(sprite);
        }
      }

      sprites.Sort((left, right) => string.CompareOrdinal(left ? left.name : string.Empty, right ? right.name : string.Empty));

      return sprites;
    }

    private static bool TryParseTextureImporterType(string value, out TextureImporterType parsed)
    {
      if (string.IsNullOrWhiteSpace(value))
      {
        parsed = TextureImporterType.Default;
        return true;
      }

      switch (value.Trim().ToLowerInvariant())
      {
        case "default":
          parsed = TextureImporterType.Default;
          return true;
        case "sprite":
          parsed = TextureImporterType.Sprite;
          return true;
        case "normalmap":
        case "normal_map":
          parsed = TextureImporterType.NormalMap;
          return true;
        case "gui":
        case "ui":
          parsed = TextureImporterType.GUI;
          return true;
        case "cursor":
          parsed = TextureImporterType.Cursor;
          return true;
        case "cookie":
          parsed = TextureImporterType.Cookie;
          return true;
        case "lightmap":
          parsed = TextureImporterType.Lightmap;
          return true;
        case "singlechannel":
        case "singechannel":
        case "single_channel":
          parsed = TextureImporterType.SingleChannel;
          return true;
        default:
          parsed = TextureImporterType.Default;
          return false;
      }
    }

    private static Type ResolveType(string typeName)
    {
      if (string.IsNullOrWhiteSpace(typeName))
      {
        return null;
      }

      var trimmed = typeName.Trim();
      var found = Type.GetType(trimmed);
      if (found != null)
      {
        return found;
      }

      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        try
        {
          var candidate = assembly.GetType(trimmed);
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

      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        try
        {
          foreach (var candidate in assembly.GetTypes())
          {
            if (candidate != null && string.Equals(candidate.Name, trimmed, StringComparison.Ordinal))
            {
              return candidate;
            }
          }
        }
        catch
        {
          // ignore and continue
        }
      }

      return null;
    }

    private static bool ParseBoolean(string value, bool fallback)
    {
      if (string.IsNullOrWhiteSpace(value))
      {
        return fallback;
      }

      switch (value.Trim().ToLowerInvariant())
      {
        case "1":
        case "true":
        case "yes":
        case "y":
        case "on":
          return true;
        case "0":
        case "false":
        case "no":
        case "n":
        case "off":
          return false;
        default:
          return fallback;
      }
    }

    private static string Encode(ResultPayload payload)
    {
      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
