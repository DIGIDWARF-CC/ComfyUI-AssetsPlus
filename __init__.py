try:
    from .assets_plus import api  # noqa: F401  # register routes
except ImportError:
    pass  # running outside ComfyUI (e.g. tests)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
