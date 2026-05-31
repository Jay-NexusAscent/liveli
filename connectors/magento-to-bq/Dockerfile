# Python 3.10 (not 3.11): hotglue's tap-magento pins python ">=3.6.2,<3.11",
# so on a 3.11 base `meltano install` fails with "Package 'tap-magento'
# requires a different Python: 3.11.x not in '<3.11,>=3.6.2'". 3.10 satisfies
# the constraint.
FROM meltano/meltano:v3.7.1-python3.10
WORKDIR /project
COPY meltano.yml ./
# Meltano 3.x doesn't bundle the plugin hub registry — fetch the plugin
# definitions, then install. Without this, every `meltano install` fails
# with "Extractor 'tap-X' is not known to Meltano".
RUN meltano lock --update --all && meltano install
# The target-bigquery venv pulls in `fs`, whose __init__.py calls
# `pkg_resources.declare_namespace(__name__)`. setuptools >=81 removed
# pkg_resources, so on first run the loader crashes with
# `ModuleNotFoundError: No module named 'pkg_resources'`. Pin the
# loader venv's setuptools to a version that still ships pkg_resources.
RUN .meltano/loaders/target-bigquery/venv/bin/pip install 'setuptools<81'
# GCS state backend support. Meltano dispatches to fsspec for state
# backends; the gs:// scheme requires gcsfs (sans-IO filesystem
# adapter) + google-cloud-storage (auth/transport). Without these
# Meltano errors out at startup with "Filesystem driver `gs` could
# not be loaded" when MELTANO_STATE_BACKEND_URI is set.
RUN pip install --no-cache-dir gcsfs google-cloud-storage
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
